import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDatabase } from "../seed.js";

let path: string | undefined;
/** Process-owned public fixture. Never reads or replaces the user's data directory. */
export function seedFixturePath(): string {
	if (!path) {
		const dir = mkdtempSync(
			join(realpathSync(tmpdir()), "skillsmith-test-seed-"),
		);
		path = join(dir, "seed.sqlite");
		try {
			seedDatabase({ destination: path });
		} catch (error) {
			path = undefined;
			rmSync(dir, { recursive: true, force: true });
			throw error;
		}
		process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
	}
	return path;
}
