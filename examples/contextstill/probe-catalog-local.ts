/** Offline phase probe: exact fixture artifacts, synthetic storage load, no inference or network. */
import "../../scripts/test-preload.js";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSkillSmith } from "../../src/index.js";
import { replayLibrary } from "./replay-library.js";
import { addCatalogLoad } from "./catalog-load.js";
const root = resolve(import.meta.dir, "../.."),
	dir = mkdtempSync(join(tmpdir(), "smith-local-catalog-"));
const levels = [9, 1000, 10000],
	rows: unknown[] = [];
try {
	const lib = await replayLibrary(root, dir);
	try {
		const store = lib.ports.approvedSkills!,
			original = store.list(lib.db, "example", 20)[0]!;
		const approved = new Set<string>(),
			wasCurrent = store.approvalCurrent;
		store.approvalCurrent = (tx, r) =>
			wasCurrent(tx, r) || approved.has(r.digest);
		const service = createSkillSmith(lib.ports),
			auth = lib.ports.repository.request(
				lib.db,
				original.template.requestRef,
			)!.authority;
		const request = lib.ports.repository.request(
			lib.db,
			original.template.requestRef,
		)!.request;
		const suite = JSON.parse(
			readFileSync(
				join(root, "docs/quality/low-latency-2026-11-08/selection-suite.json"),
				"utf8",
			),
		);
		let inserted = 0;
		for (const level of levels) {
			const prep = addCatalogLoad(
				lib.db,
				store,
				original,
				inserted,
				level - 3,
				approved,
			);
			inserted = level - 3;
			for (const task of suite.cases.filter(
				(t: { expected: string | null }) => t.expected,
			)) {
				const samples: number[] = [];
				for (let i = 0; i < 5; i++) {
					const start = performance.now();
					const p = service.prepareSkillSelection(
						lib.db,
						{ ...request, task: { ...request.task, goal: task.goal } },
						auth,
					);
					samples.push(performance.now() - start);
					if (
						!p.candidates.some(
							(c) =>
								c.ref ===
								lib.publications.find((p) => p.taskId === task.expected)!.ref,
						)
					)
						throw Error("lost_candidate");
				}
				rows.push({
					level,
					task: task.id,
					samplesMs: samples,
					constructionMs: prep.preparationMs,
				});
			}
			console.log(JSON.stringify({ level, complete: true }));
		}
	} finally {
		lib.close();
	}
	writeFileSync(
		resolve(process.argv[2] ?? "artifacts/catalog-local.json"),
		JSON.stringify({ networkCalls: 0, rows }, null, 2) + "\n",
	);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
