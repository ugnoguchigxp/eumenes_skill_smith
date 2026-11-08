import { test, expect } from "bun:test";
import {
	mkdtemp,
	cp,
	symlink,
	readFile,
	writeFile,
	rm,
	mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("release rejects stale inputs, tampering and mixed files; extracted consumer completes lifecycle", async () => {
	const root = resolve(import.meta.dir, "../..");
	const dir = await mkdtemp(join(tmpdir(), "skillsmith-release-"));
	const command = async (...args: string[]) => {
		const process = Bun.spawn([Bun.which("bun")!, ...args], {
			cwd: dir,
			env: { ...globalThis.process.env, NODE_PATH: join(root, "node_modules") },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stdout, stderr] = await Promise.all([
			process.exited,
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
		]);
		return { code, output: stdout + stderr };
	};
	try {
		for (const path of [
			"src",
			"scripts",
			"package.json",
			"bun.lock",
			"tsconfig.json",
			"tsconfig.build.json",
			"LICENSE",
			"README.md",
		])
			await cp(join(root, path), join(dir, path), { recursive: true });
		await symlink(join(root, "node_modules"), join(dir, "node_modules"), "dir");
		expect(await command("run", "build")).toMatchObject({ code: 0 });
		const originalSource = await readFile(join(dir, "src/index.ts"), "utf8");
		await writeFile(
			join(dir, "src/index.ts"),
			originalSource + "\n// changed after build\n",
		);
		expect((await command("run", "pack:core")).output).toContain(
			"stale_build_inputs",
		);
		await writeFile(join(dir, "src/index.ts"), originalSource);
		const originalOutput = await readFile(join(dir, "dist/index.js"), "utf8");
		await writeFile(
			join(dir, "dist/index.js"),
			originalOutput + "\nthrow Error('tamper');\n",
		);
		expect((await command("run", "pack:core")).output).toContain(
			"build_output_changed",
		);
		await writeFile(join(dir, "dist/index.js"), originalOutput);
		await writeFile(join(dir, "dist/private.sqlite"), "unwanted");
		expect((await command("run", "pack:core")).code).not.toBe(0);
		await rm(join(dir, "dist/private.sqlite"));
		await symlink(join(dir, "README.md"), join(dir, "dist/leak.js"));
		expect((await command("run", "pack:core")).output).toContain(
			"package_symlink",
		);
		await rm(join(dir, "dist/leak.js"));
		const packed = await command("run", "pack:core");
		expect(packed.output).not.toContain("error:");
		expect(packed.code).toBe(0);
		const manifest = JSON.parse(
			await readFile(join(dir, "artifacts/manifest.json"), "utf8"),
		);
		expect(manifest.buildInputDigest).toHaveLength(64);
		expect(manifest.sourceGitCommit).toBeNull();
		const extracted = join(dir, "extracted");
		await mkdir(extracted);
		const tar = Bun.spawn([
			"tar",
			"-xzf",
			join(dir, "artifacts", manifest.artifact),
			"-C",
			extracted,
		]);
		expect(await tar.exited).toBe(0);
		const fixture = (
			await readFile(join(root, "src/test/fixture-host.ts"), "utf8")
		)
			.replaceAll('"../index.js"', '"./extracted/package/dist/index.js"')
			.replaceAll(
				'"../sqlite/index.js"',
				'"./extracted/package/dist/sqlite/index.js"',
			);
		await writeFile(join(dir, "consumer-fixture.ts"), fixture);
		await writeFile(
			join(dir, "consumer.ts"),
			[
				'import {fixture,ready} from "./consumer-fixture.ts";',
				'globalThis.fetch=()=>{throw Error("consumer_network")}; Bun.serve=()=>{throw Error("consumer_listener")};',
				'const f=fixture(); try { const r=await ready(f); f.service.bindUse(f.db,r.build.ref,"consumer-execution",f.auth,f.request);',
				'f.service.reportResult(f.db,{reportId:"report",buildRef:r.build.ref,executionRef:"consumer-execution",outcome:"succeeded",summary:"ok",evidence:[],expectedRevision:0},f.auth);',
				'const pending=f.ports.repository.deliveries(f.db,10); if(pending.length!==1)throw Error("delivery_missing"); f.write(()=>f.ports.repository.ackDelivery(f.db,pending[0].id)); if(f.ports.repository.deliveries(f.db,10).length)throw Error("ack_failed"); } finally {f.dispose();}',
			].join("\n"),
		);
		expect(await command("consumer.ts")).toMatchObject({ code: 0 });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}, 30000);
