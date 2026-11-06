import { rm } from "node:fs/promises";
import { resolve } from "node:path";
await rm(resolve(import.meta.dir, "../dist"), { recursive: true, force: true });
const compiler = Bun.spawn(["tsc", "-p", "tsconfig.build.json"], {
	stdout: "inherit",
	stderr: "inherit",
});
process.exit(await compiler.exited);
