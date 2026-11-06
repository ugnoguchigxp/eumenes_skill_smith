import { readFileSync } from "node:fs";
import { bunAtLeast, requiredBunVersion } from "./bun-version.js";

const pkg = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { packageManager?: string };
const required = requiredBunVersion(pkg.packageManager);
if (!required) {
	console.error("package.json packageManager must declare bun@x.y.z");
	process.exit(1);
}
if (!bunAtLeast(Bun.version, required)) {
	console.error(
		`verify requires Bun ${required} or newer (packageManager); this process is Bun ${Bun.version}. ` +
			`Use the Bun ${required} binary (for example /home/box/.bun/bin/bun) ahead of older PATH entries.`,
	);
	process.exit(1);
}

const steps = [
	["bun", "run", "typecheck"],
	["bun", "run", "lint"],
	["bun", "run", "format:check"],
	["bun", "test", "src/test"],
	["bun", "test", "examples/contextstill/test"],
	["bun", "run", "build"],
	["bun", "run", "pack:core"],
];
for (const command of steps) {
	const result = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
	if ((await result.exited) !== 0) process.exit(1);
}
