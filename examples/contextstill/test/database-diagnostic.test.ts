import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStillFixture } from "../database.js";
import { FORMAT } from "../contracts.js";

for (const format of ["old-schema", "wrong-format", "raw"] as const) {
	test("fixture diagnostic preserves existing " + format + " database", () => {
		const dir = mkdtempSync(
			join(realpathSync(tmpdir()), "fixture-diagnostic-"),
		);
		try {
			const path = join(dir, "existing.sqlite");
			const db = new Database(path);
			db.exec("CREATE TABLE items(handle TEXT)");
			if (format !== "raw") {
				db.exec("CREATE TABLE fixture_metadata(key TEXT,value TEXT)");
				db.query("INSERT INTO fixture_metadata VALUES('format',?)").run(
					JSON.stringify(format === "old-schema" ? FORMAT : "wrong"),
				);
			}
			db.close();
			const before = readFileSync(path);
			expect(() => new ContextStillFixture(path)).toThrow(
				format === "old-schema"
					? "fixture_schema_outdated: rebuild with context:seed --replace or context:snapshot --replace"
					: "fixture_snapshot_required",
			);
			expect(readFileSync(path)).toEqual(before);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
