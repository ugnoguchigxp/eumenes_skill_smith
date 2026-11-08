import { Database } from "bun:sqlite";
import { test, expect } from "bun:test";
import { migrations, sqliteRepository } from "../sqlite/index.js";
import { fixture, ready } from "./fixture.js";

test("lookup migration upgrades v1 rows, is repeatable and indexes malformed JSON safely", () => {
	const db = new Database(":memory:");
	try {
		db.exec(migrations[0].sql);
		db.query("INSERT INTO knowledge_results VALUES(?,?,?,?)").run(
			"scope",
			"broken",
			1,
			"{bad",
		);
		for (const m of migrations.slice(1)) {
			db.exec(m.sql);
			db.exec(m.sql);
		}
		expect(sqliteRepository.reportsByBuild(db, "scope", "different")).toEqual(
			[],
		);
		expect(() => sqliteRepository.report(db, "scope", "broken")).toThrow(
			"corrupt_storage",
		);
		const indexes = db
			.query("SELECT name FROM sqlite_schema WHERE type='index'")
			.all() as { name: string }[];
		expect(indexes.some((i) => i.name === "knowledge_results_build")).toBe(
			true,
		);
		expect(
			indexes.some((i) => i.name === "knowledge_proposals_execution"),
		).toBe(true);
	} finally {
		db.close();
	}
});
test("indexed history lookups isolate unrelated malformed rows and preserve report corrections", async () => {
	const f = fixture();
	const r = await ready(f);
	f.service.bindUse(f.db, r.build.ref, "target", f.auth, f.request);
	const report = {
		reportId: "r1",
		buildRef: r.build.ref,
		executionRef: "target",
		outcome: "succeeded" as const,
		summary: "ok",
		evidence: [],
		expectedRevision: 0,
	};
	f.service.reportResult(f.db, report, f.auth);
	const insert = f.db.query("INSERT INTO knowledge_results VALUES(?,?,?,?)");
	const propose = f.db.query("INSERT INTO knowledge_proposals VALUES(?,?,?,?)");
	f.db.transaction(() => {
		for (let i = 0; i < 1000; i++) {
			insert.run(
				f.auth.scope,
				"unrelated:" + i,
				1,
				JSON.stringify({ input: { buildRef: "other:" + i } }),
			);
			propose.run(
				"p:" + i,
				f.auth.scope,
				0,
				JSON.stringify({ executionRef: "other:" + i }),
			);
		}
	})();
	expect(
		sqliteRepository.reportsByBuild(f.db, f.auth.scope, r.build.ref),
	).toHaveLength(1);
	expect(
		sqliteRepository.proposalsByExecution(f.db, f.auth.scope, "target"),
	).toEqual([]);
	f.service.reportResult(
		f.db,
		{ ...report, reportId: "r2", expectedRevision: 1, outcome: "failed" },
		f.auth,
	);
	expect(
		sqliteRepository.reportsByBuild(f.db, f.auth.scope, r.build.ref)[0]!.input
			.outcome,
	).toBe("failed");
	const queries: string[] = [];
	const original = f.db.query.bind(f.db);
	f.db.query = ((sql: string) => {
		queries.push(sql);
		return original(sql);
	}) as typeof f.db.query;
	sqliteRepository.reportsByBuild(f.db, f.auth.scope, r.build.ref);
	sqliteRepository.proposalsByExecution(f.db, f.auth.scope, "target");
	f.db.query = original;
	const plans = queries.map((sql, i) =>
		f.db
			.query("EXPLAIN QUERY PLAN " + sql)
			.all(f.auth.scope, i ? "target" : r.build.ref),
	);
	expect(JSON.stringify(plans[0])).toContain("knowledge_results_build");
	expect(JSON.stringify(plans[1])).toContain("knowledge_proposals_execution");
});
