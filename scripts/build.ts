import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha, hashes, inputs } from "./source-manifest.js";
const root = resolve(import.meta.dir, "..");
const stamp = resolve(root, "artifacts/build-input.json");
await rm(stamp, { force: true });
const before = await inputs(root);
await rm(resolve(root, "dist"), { recursive: true, force: true });
const compiler = Bun.spawn(["tsc", "-p", "tsconfig.build.json"], {
	stdout: "inherit",
	stderr: "inherit",
});
if ((await compiler.exited) !== 0) process.exit(1);
if (JSON.stringify(before) !== JSON.stringify(await inputs(root)))
	throw new Error("build_inputs_changed");
await mkdir(resolve(root, "artifacts"), { recursive: true });
await writeFile(
	stamp,
	JSON.stringify(
		{
			...before,
			outputDigest: sha(JSON.stringify(await hashes(resolve(root, "dist")))),
		},
		null,
		2,
	) + "\n",
);
