import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sha, files, hashes as fileHashes, inputs } from "./source-manifest.js";
const root = resolve(import.meta.dir, "..");
const buildInputs = await inputs(root);
const built = JSON.parse(
	await readFile(join(root, "artifacts/build-input.json"), "utf8"),
);
if (
	built.sourceDigest !== buildInputs.sourceDigest ||
	built.buildInputDigest !== buildInputs.buildInputDigest
)
	throw new Error("stale_build_inputs: run build before pack:core");
if (
	built.outputDigest !==
	sha(JSON.stringify(await fileHashes(join(root, "dist"))))
)
	throw new Error("build_output_changed: run build before pack:core");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const stage = await mkdtemp(join(tmpdir(), "skillsmith-pack-"));
try {
	const target = join(stage, "package");
	await mkdir(target);
	await cp(join(root, "dist"), join(target, "dist"), { recursive: true });
	const contents = await files(target);
	if (
		!contents.length ||
		contents.some(
			(p) =>
				!p.startsWith("dist/") ||
				/(^|\/)(test|fixtures)(\/|\.)/.test(p) ||
				!/\.(js|d\.ts)$/.test(p),
		)
	)
		throw new Error("invalid_package_contents");
	for (const file of ["LICENSE", "README.md"])
		await cp(join(root, file), join(target, file));
	await writeFile(
		join(target, "package.json"),
		JSON.stringify(
			{
				name: pkg.name,
				version: pkg.version,
				license: pkg.license,
				type: "module",
				private: true,
				sideEffects: false,
				exports: pkg.exports,
				dependencies: pkg.dependencies,
			},
			null,
			2,
		) + "\n",
	);
	const hashes: Record<string, string> = {};
	for (const path of await files(target))
		hashes[path] = sha(await readFile(join(target, path)));
	const git = Bun.spawn(["git", "rev-parse", "HEAD"], {
		cwd: root,
		stdout: "pipe",
		stderr: "ignore",
	});
	const commit =
		(await git.exited) === 0
			? (await new Response(git.stdout).text()).trim()
			: null;
	const dirtyProcess = Bun.spawn(
		["git", "status", "--porcelain", "--untracked-files=normal"],
		{ cwd: root, stdout: "pipe", stderr: "ignore" },
	);
	const sourceGitDirty =
		(await dirtyProcess.exited) === 0
			? !!(await new Response(dirtyProcess.stdout).text()).trim()
			: null;
	const manifest = {
		package: pkg.name,
		version: pkg.version,
		contractVersion: "skillsmith.v1",
		sourceGitCommit: commit,
		sourceGitDirty,
		...buildInputs,
		files: hashes,
	};
	await writeFile(
		join(target, "MANIFEST.json"),
		JSON.stringify(manifest, null, 2) + "\n",
	);
	for (const [path, hash] of Object.entries(hashes))
		if (sha(await readFile(join(target, path))) !== hash)
			throw new Error("package_checksum");
	if (JSON.stringify(buildInputs) !== JSON.stringify(await inputs(root)))
		throw new Error("package_inputs_changed");
	if (
		built.outputDigest !==
		sha(JSON.stringify(await fileHashes(join(root, "dist"))))
	)
		throw new Error("package_output_changed");
	await mkdir(join(root, "artifacts"), { recursive: true });
	const artifact = join(
		root,
		"artifacts",
		pkg.name + "-" + pkg.version + ".tgz",
	);
	const tar = Bun.spawn(["tar", "-czf", artifact, "-C", stage, "package"], {
		env: { ...process.env, COPYFILE_DISABLE: "1" },
		stdout: "inherit",
		stderr: "inherit",
	});
	if ((await tar.exited) !== 0) throw new Error("package_failed");
	await writeFile(
		join(root, "artifacts", "manifest.json"),
		JSON.stringify(
			{
				...manifest,
				artifact: artifact.split("/").at(-1),
				sha256: sha(await readFile(artifact)),
			},
			null,
			2,
		) + "\n",
	);
	const inspect = await mkdtemp(join(tmpdir(), "skillsmith-import-"));
	try {
		const extract = Bun.spawn(["tar", "-xzf", artifact, "-C", inspect]);
		if ((await extract.exited) !== 0) throw new Error("package_extract_failed");
		const consumer = Bun.spawn(
			[
				"bun",
				"-e",
				`globalThis.fetch=()=>{throw Error("import_network")}; Bun.serve=()=>{throw Error("import_listener")}; const m=await import(${JSON.stringify(join(inspect, "package/dist/index.js"))}); const s=await import(${JSON.stringify(join(inspect, "package/dist/sqlite/index.js"))}); if(typeof m.createSkillSmith!=="function" || !s.migrations.length)throw Error("export_missing");`,
			],
			{
				env: { ...process.env, NODE_PATH: join(root, "node_modules") },
				stdout: "inherit",
				stderr: "inherit",
			},
		);
		if ((await consumer.exited) !== 0) throw new Error("package_import_failed");
	} finally {
		await rm(inspect, { recursive: true, force: true });
	}
	process.stdout.write(
		JSON.stringify({
			artifact,
			files: Object.keys(hashes).length,
			sourceGitCommit: commit,
		}) + "\n",
	);
} finally {
	await rm(stage, { recursive: true, force: true });
}
