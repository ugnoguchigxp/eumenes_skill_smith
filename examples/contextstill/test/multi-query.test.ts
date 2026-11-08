import { seedFixturePath } from "./seed-fixture.js";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	createMultiQuerySource,
	multiQueryOutputSchema,
	multiQueryDigests,
	MULTI_QUERY_INSTRUCTIONS,
	MULTI_QUERY_MAX_OUTPUT_TOKENS,
} from "../multi-query.js";
import { inferenceTask, recordedInference } from "../recorded.js";
import { buildEvalIdentity } from "../scenario-runner.js";
import type { SourcePort } from "../source.js";
import { setup } from "./fixture.js";

const deadlineAt = 1_700_000_000_000 + 120_000;
// Synthetic unit-test responses only: these are NOT model outputs or evaluation records.
function model(
	value: unknown,
	onTask = (_task: ReturnType<typeof inferenceTask>) => {},
) {
	return recordedInference(
		[
			{
				inputDigest: inferenceTask({
					system: MULTI_QUERY_INSTRUCTIONS,
					data: { searchTask: "public" },
					schema: multiQueryOutputSchema,
					requestRef: "multi-query-reformulation",
					maxOutputTokens: MULTI_QUERY_MAX_OUTPUT_TOKENS,
					deadlineAt,
				}).inputDigest,
				value,
				provider: "test-double",
			},
		],
		onTask,
	);
}

test("cap enforced in schema AND runtime; malformed output never searches", async () => {
	expect(multiQueryOutputSchema.properties.queries.maxItems).toBe(2);
	const f = setup();
	for (const value of [
		{ queries: ["one", "two", "three"] },
		{ queries: [] },
		{ queries: [" "] },
		{ queries: ["x".repeat(201)] },
		{ query: "one" },
		{ queries: ["one"], extra: true },
	]) {
		let calls = 0;
		const source = createMultiQuerySource(
			{
				...f.source,
				search: async () => {
					calls++;
					throw new Error("unexpected");
				},
			},
			model(value),
			{ deadlineAt },
		);
		await expect(source.search("public", 8, f.signal)).rejects.toThrow(
			"multi_query_output_invalid",
		);
		expect(calls).toBe(0);
	}
});

test("RRF dedupes exact versions, preserves notices/versions, bounds output; no selection inference", async () => {
	const f = setup();
	const card = (await f.source.search("検証", 1, f.signal)).cards[0]!;
	const other = {
		...card,
		ref: "other",
		version: { ...card.version, id: "other" },
	};
	const revised = {
		...card,
		version: { ...card.version, version: "2" },
		status: "superseded" as const,
		complete: false,
	};
	let calls = 0;
	let inferenceCalls = 0;
	const traces: unknown[] = [];
	const inner: SourcePort = {
		...f.source,
		search: async (_query, limit, signal) => {
			expect(limit).toBe(2);
			expect(signal).toBe(f.signal);
			return ++calls === 1
				? {
						cards: [other, card],
						warnings: [{ kind: "notice-a", refs: [card.ref] }],
						degraded: ["a"],
						truncated: false,
					}
				: {
						cards: [card, revised],
						warnings: [{ kind: "notice-b", refs: [other.ref] }],
						degraded: ["b"],
						truncated: true,
					};
		},
	};
	const source = createMultiQuerySource(
		inner,
		model({ queries: ["one", "two"] }, () => inferenceCalls++),
		{
			deadlineAt,
			onTrace: (trace) => traces.push(trace),
		},
	);
	const result = await source.search("public", 2, f.signal);
	expect(result.cards).toEqual([card, other]);
	expect(result.cards.filter((c) => c.ref === card.ref)).toHaveLength(1);
	expect(result.warnings.map((w) => w.kind)).toEqual(["notice-a", "notice-b"]);
	expect(result.degraded).toEqual(["a", "b"]);
	expect(result.truncated).toBe(true);
	expect(calls).toBe(2);
	expect(inferenceCalls).toBe(1);
	expect(traces).toMatchObject([
		{
			searchTask: "public",
			queries: ["one", "two"],
			queryToSource: ["one", "two"],
			perQuery: [
				{ query: "one", cards: [other, card] },
				{ query: "two", cards: [card, revised] },
			],
		},
	]);
	// A distinct version must not be collapsed into the earlier one.
	const versions = createMultiQuerySource(
		{
			...inner,
			search: async () => ({
				cards: [card, revised],
				warnings: [],
				degraded: [],
				truncated: false,
			}),
		},
		model({ queries: ["one", "two"] }),
		{ deadlineAt },
	);
	expect((await versions.search("public", 8, f.signal)).cards).toEqual([
		card,
		revised,
	]);
});

test("get/validate remain delegated; abort prevents all auxiliary and source calls", async () => {
	const f = setup();
	let aux = 0;
	let got = false;
	let validated = false;
	const source = createMultiQuerySource(
		{
			...f.source,
			get: async (...args) => {
				got = true;
				return f.source.get(...args);
			},
			validate: async () => {
				validated = true;
				return false;
			},
		},
		model({ queries: ["one"] }, () => aux++),
		{ deadlineAt },
	);
	const card = (await f.source.search("検証", 1, f.signal)).cards[0]!;
	await source.get(card.ref, f.signal);
	expect(got).toBe(true);
	expect(await source.validate([], f.signal)).toBe(false);
	expect(validated).toBe(true);
	await expect(
		source.search("public", 8, AbortSignal.abort()),
	).rejects.toThrow();
	expect(aux).toBe(0);
});

test("multi identity differs from single, auxiliary reformulation stays independent of the current build version", () => {
	const paths = {
		searchProfile: "bm25" as const,
		suiteId: "s",
		suitePath: "examples/contextstill/scenarios/suite.json",
		seedPath: seedFixturePath(),
	};
	const multi = buildEvalIdentity({ ...paths, queryReformulation: "multi" });
	const single = buildEvalIdentity({ ...paths, queryReformulation: "on" });
	const off = buildEvalIdentity(paths);
	expect(multi).toMatchObject(multiQueryDigests());
	expect(multi.reformulationInstructionsDigest).not.toBe(
		single.reformulationInstructionsDigest,
	);
	expect(multi.reformulationSchemaDigest).not.toBe(
		single.reformulationSchemaDigest,
	);
	expect(multi.buildInstructionsDigest).toBe(off.buildInstructionsDigest);
	const prior = JSON.parse(
		readFileSync(
			"examples/contextstill/scenarios/retrieval-jp-bm25-reformulation.json",
			"utf8",
		),
	);
	expect(single.reformulationInstructionsDigest).toBe(
		prior.identity.reformulationInstructionsDigest,
	);
	expect(single.reformulationSchemaDigest).toBe(
		prior.identity.reformulationSchemaDigest,
	);
	expect(multi.buildInstructionsDigest).not.toBe(
		prior.identity.buildInstructionsDigest,
	);
});

test("CLI replay: single JP BM25 stays 15/16; off keeps old ranks and auto reformulates original five", () => {
	const f = setup();
	for (const profile of ["handle", "bm25"]) {
		for (const mode of [undefined, "off", "on"]) {
			if (mode === "on" && profile !== "bm25") continue;
			const result = Bun.spawnSync([
				process.execPath,
				"examples/contextstill/scenario-eval.ts",
				"--db",
				seedFixturePath(),
				"--retrieval-only",
				"--replay-namespace",
				"legacy",
				"--output-dir",
				f.dir,
				"--search-profile",
				profile,
				...(mode ? ["--query-reformulation", mode] : []),
				...(mode === "on"
					? [
							"--suite",
							"examples/contextstill/scenarios/suite-3axis.json",
							"--axis",
							"retrieval",
							"--query-style",
							"jp",
							"--reformulation-records",
							"examples/contextstill/scenarios/reformulation-records.json",
						]
					: []),
			]);
			expect(result.exitCode).toBe(0);
			const report = JSON.parse(result.stdout.toString());
			if (mode === "on") {
				expect(report.rows).toHaveLength(16);
				expect(
					report.rows.filter(
						(r: { allRequiredHitAt8: boolean }) => r.allRequiredHitAt8,
					),
				).toHaveLength(15);
				expect(report.reformulationInferenceTasks).toBe(16);
				expect(report.inputTokens).toBeNull();
				expect(report.outputTokens).toBeNull();
			} else {
				expect(
					report.rows.map(
						(r: { ranks: { rank: number | null }[] }) => r.ranks[0]!.rank,
					),
				).toEqual(
					profile === "handle"
						? [mode === "off" ? 6 : 4, 1, null, null, null]
						: [1, 1, 1, 1, 1],
				);
				expect(report.identity.queryReformulation).toBe(
					mode === "off" ? "off" : "on",
				);
				if (mode === undefined)
					expect(report.reformulationInferenceTasks).toBe(5);
			}
		}
	}
});

test("fusion fails closed rather than discard warnings or return out-of-set notice refs", async () => {
	const f = setup();
	const card = (await f.source.search("検証", 1, f.signal)).cards[0]!;
	let calls = 0;
	const traces: unknown[] = [];
	const source = createMultiQuerySource(
		{
			...f.source,
			search: async () => {
				const current =
					++calls === 1
						? card
						: {
								...card,
								ref: "other",
								version: { ...card.version, id: "other" },
							};
				return {
					cards: [current],
					warnings: [{ kind: "notice", refs: [current.ref] }],
					degraded: [],
					truncated: false,
				};
			},
		},
		model({ queries: ["one", "two"] }),
		{ deadlineAt, onTrace: (t) => traces.push(t) },
	);
	await expect(source.search("public", 1, f.signal)).rejects.toThrow(
		"multi_query_fusion_contract_violation",
	);
	expect(traces).toMatchObject([
		{
			queryToSource: ["one", "two"],
			perQuery: [
				{ warnings: [{ kind: "notice", refs: [card.ref] }] },
				{ warnings: [{ kind: "notice", refs: ["other"] }] },
			],
		},
	]);
});
