/** Manual fault injection into a disposable copy; never edits the working source. */
import {
	cp,
	mkdtemp,
	mkdir,
	readFile,
	writeFile,
	rm,
	symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const dir = await mkdtemp(join(tmpdir(), "skillsmith-controls-"));
const out = join(root, "artifacts/boundary-controls");
const tests = [
	"result-authority",
	"requests",
	"build",
	"localized-build",
	"proposal-cancellation",
	"skill-markdown",
	"usage-ledger",
].map((p) => "src/test/" + p + ".test.ts");
const controls = [
	[
		"principal",
		"authority.ts",
		"row.authority.principal === auth.principal",
		"true",
	],
	["epoch", "authority.ts", "row.authority.epoch === auth.epoch", "true"],
	[
		"origin-sources",
		"authority.ts",
		"...row.authority.sourceRefs, ...refs",
		"...refs",
	],
	["execution", "authority.ts", "buildRef,\n\t\t\texecutionRef,", "buildRef,"],
	[
		"budget-reservation",
		"index.ts",
		"row.usage[kind]++;",
		"row.usage[kind] += 0;",
	],
	["run-token", "index.ts", "row.runToken !== s.runToken", "false"],
	[
		"receipt",
		"index.ts",
		"!p.inference.validReceipt(tx, result.receipt)",
		"false",
	],
	["delivery", "index.ts", "repo.putDelivery(tx, {", "void ({"],
	["cancellation", "results.ts", "context.signal.throwIfAborted();", "void 0;"],
	[
		"canonical-body",
		"skill-markdown.ts",
		'build.body === canonical, "skill_body_mismatch"',
		'true, "skill_body_mismatch"',
	],
] as const;
const results: { control: string; detected: boolean; durationMs: number }[] =
	[];
try {
	for (const path of [
		"src",
		"scripts",
		"package.json",
		"bunfig.toml",
		"tsconfig.json",
	])
		await cp(join(root, path), join(dir, path), { recursive: true });
	await symlink(join(root, "node_modules"), join(dir, "node_modules"), "dir");
	await mkdir(out, { recursive: true });
	const run = async (name: string) => {
		const start = performance.now();
		const child = Bun.spawn([process.execPath, "test", ...tests], {
			cwd: dir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		const log = stdout + stderr;
		await writeFile(join(out, name + ".log"), log);
		return { code, log, durationMs: performance.now() - start };
	};
	if ((await run("baseline")).code !== 0)
		throw new Error("control_baseline_failed");
	for (const [control, file, before, after] of controls) {
		const path = join(dir, "src/service", file);
		const source = await readFile(path, "utf8");
		if (!source.includes(before))
			throw new Error("control_target_missing:" + control);
		await writeFile(path, source.replaceAll(before, after));
		const result = await run(control);
		await writeFile(path, source);
		if (/SyntaxError|Cannot find module|ParseError/.test(result.log))
			throw new Error("control_invalid:" + control);
		const detected = result.code !== 0 && /\(fail\)/.test(result.log);
		results.push({ control, detected, durationMs: result.durationMs });
		console.log(JSON.stringify(results.at(-1)));
	}
	await writeFile(
		join(out, "results.json"),
		JSON.stringify({ at: new Date().toISOString(), tests, results }, null, 2) +
			"\n",
	);
	if (results.some((r) => !r.detected)) process.exitCode = 1;
} finally {
	await rm(dir, { recursive: true, force: true });
}
