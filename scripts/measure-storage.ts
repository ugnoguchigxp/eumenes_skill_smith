/** Synthetic indexed history workload. These are not provider or production timings. */
import { Database } from "bun:sqlite";
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrations, sqliteRepository } from "../src/sqlite/index.js";
const contract = {
	sizes: [100, 1000, 10000],
	iterations: 200,
	targetRows: [0, 1, 8],
	workers: 1,
	p95MaxMs: 10,
	growthMax: 2,
};
// Include misses and fixed-size hits; target-external malformed schemas must not be parsed.
const dir = await mkdtemp(join(tmpdir(), "skillsmith-perf-"));
const records: unknown[] = [];
const summaries: {
	size: number;
	targetRows: number;
	mode: string;
	p50: number;
	p95: number;
	max: number;
	parsed: number;
}[] = [];
try {
	for (const targetRows of contract.targetRows) {
		for (const size of contract.sizes) {
			const path = join(dir, targetRows + "-" + size + ".sqlite");
			let db = new Database(path);
			for (const m of migrations) db.exec(m.sql);
			db.transaction(() => {
				for (let i = 0; i < size; i++) {
					db.query("INSERT INTO knowledge_results VALUES(?,?,?,?)").run(
						"scope",
						"e:" + i,
						1,
						JSON.stringify({ input: { buildRef: "build:" + i } }),
					);
					db.query("INSERT INTO knowledge_proposals VALUES(?,?,?,?)").run(
						"p:" + i,
						"scope",
						0,
						JSON.stringify({ executionRef: "e:" + i }),
					);
				}
				for (let i = 0; i < targetRows; i++) {
					db.query("INSERT INTO knowledge_results VALUES(?,?,?,?)").run(
						"scope",
						"target:" + i,
						1,
						JSON.stringify({
							scope: "scope",
							revision: 1,
							digest: "report-digest",
							input: {
								reportId: "r:" + i,
								buildRef: "target",
								executionRef: "target:" + i,
								outcome: "succeeded",
								summary: "ok",
								evidence: [],
								expectedRevision: 0,
							},
						}),
					);
					db.query("INSERT INTO knowledge_proposals VALUES(?,?,?,?)").run(
						"target:" + i,
						"scope",
						0,
						JSON.stringify({
							ref: "target:" + i,
							scope: "scope",
							buildRef: "target",
							executionRef: "target",
							sections: [],
							conditions: [],
							evidence: [],
							status: "proposed",
							revision: 0,
						}),
					);
				}
			})();
			for (const mode of ["connection-cold", "warm"]) {
				const times: number[] = [];
				let parsed = 0;
				for (let i = 0; i < contract.iterations; i++) {
					if (mode === "connection-cold") {
						db.close();
						db = new Database(path);
					}
					const original = JSON.parse;
					JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
						parsed++;
						return original(...args);
					}) as typeof JSON.parse;
					const start = performance.now();
					try {
						if (
							sqliteRepository.reportsByBuild(db, "scope", "target").length !==
								targetRows ||
							sqliteRepository.proposalsByExecution(db, "scope", "target")
								.length !== targetRows
						)
							throw Error("unexpected_target");
					} finally {
						times.push(performance.now() - start);
						JSON.parse = original;
					}
				}
				const sorted = [...times].sort((a, b) => a - b);
				const summary = {
					size,
					targetRows,
					mode,
					p50: sorted[99]!,
					p95: sorted[189]!,
					max: sorted[199]!,
					parsed,
				};
				summaries.push(summary);
				records.push({
					...summary,
					durationsMs: times,
					memory: process.memoryUsage(),
				});
			}
			db.close();
		}
	}
	const checks = contract.targetRows.flatMap((targetRows) =>
		["connection-cold", "warm"].map((mode) => {
			const small = summaries.find(
				(s) =>
					s.mode === mode && s.size === 1000 && s.targetRows === targetRows,
			)!;
			const large = summaries.find(
				(s) =>
					s.mode === mode && s.size === 10000 && s.targetRows === targetRows,
			)!;
			return {
				mode,
				targetRows,
				growth: large.p95 / small.p95,
				passed: large.p95 / small.p95 <= contract.growthMax,
			};
		}),
	);
	const passed =
		summaries.every(
			(s) =>
				s.p95 <= contract.p95MaxMs &&
				s.parsed === s.targetRows * 2 * contract.iterations,
		) && checks.every((s) => s.passed);
	const output = {
		at: new Date().toISOString(),
		synthetic: true,
		bun: Bun.version,
		platform: process.platform,
		arch: process.arch,
		contract,
		summaries,
		checks,
		passed,
		records,
	};
	await mkdir(resolve(import.meta.dir, "../artifacts"), { recursive: true });
	await writeFile(
		resolve(import.meta.dir, "../artifacts/storage-measurement.json"),
		JSON.stringify(output, null, 2) + "\n",
	);
	console.log(JSON.stringify({ summaries, checks, passed }, null, 2));
	if (!passed) process.exitCode = 1;
} finally {
	await rm(dir, { recursive: true, force: true });
}
