import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { replayLibrary } from "../replay-library.js";
import { createSkillSmith } from "../../../src/index.js";

test("three exact cloud-reviewed bundles deliver within 32KB, persist, and reject a missing reference", async () => {
	const root = resolve(import.meta.dir, "../../.."),
		dir = realpathSync(
			mkdtempSync(join(tmpdir(), "smith-approved-regression-")),
		);
	try {
		const unpack = Bun.spawnSync([
			"tar",
			"-xzf",
			join(root, "docs/quality/evidence/novel-three-evidence-2026-11-08.tgz"),
			"-C",
			dir,
			"artifacts/novel-three-2026-11-08/records.json",
			"artifacts/novel-three-2026-11-08/reviewed-skills.json",
		]);
		expect(unpack.exitCode).toBe(0);
		const frozen = JSON.parse(
			readFileSync(
				join(dir, "artifacts/novel-three-2026-11-08/reviewed-skills.json"),
				"utf8",
			),
		);
		const library = await replayLibrary(
			root,
			dir,
			join(dir, "artifacts/novel-three-2026-11-08/records.json"),
		);
		try {
			expect(library.matchedReplayCalls).toBe(12);
			expect(library.deliveries).toHaveLength(3);
			const second = new Database(join(dir, "library.sqlite"), {
				readonly: true,
			});
			try {
				for (const pub of library.publications) {
					const record = library.ports.approvedSkills!.get(second, pub.ref)!;
					expect(record.artifact).toEqual(frozen[pub.taskId]);
					expect(record.artifact.files.length).toBeGreaterThan(0);
				}
			} finally {
				second.close();
			}
			const damaged = library.ports.approvedSkills!.get(
				library.db,
				library.publications[0]!.ref,
			)!;
			damaged.artifact.files.pop();
			library.db
				.query("UPDATE knowledge_approved_skills SET data_json=? WHERE ref=?")
				.run(JSON.stringify(damaged), damaged.ref);
			const original = library.ports.repository.request(
				library.db,
				damaged.template.requestRef,
			)!;
			const service = createSkillSmith(library.ports);
			expect(() =>
				service.prepareSkillSelection(
					library.db,
					original.request,
					original.authority,
				),
			).toThrow("artifact_mismatch");
		} finally {
			library.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
