import { expect, test } from "bun:test";
import { createExampleHost } from "../host.js";
import {
	REFORMULATION_INSTRUCTIONS,
	createReformulatingSource,
	parseQueryReformulation,
	reformulationOutputSchema,
} from "../query-reformulation.js";
import { inferenceTask, recordedInference } from "../recorded.js";
import {
	buildEvalIdentity,
	runFull,
	runRetrievalOnly,
	type PendingReformulation,
} from "../scenario-runner.js";
import type { NormalizedScenarioTask } from "../../../src/eval/scenario-score.js";
import { setup } from "./fixture.js";

const CANARY = "PRIVATE_CANARY_42";
const deadlineAt = 1_700_000_000_000 + 120_000;
const task = (
	over: Partial<NormalizedScenarioTask> = {},
): NormalizedScenarioTask => ({
	id: "t",
	axis: "retrieval",
	queryStyle: "jp",
	goal: "検証",
	acceptance: [{ id: "a", text: "x" }],
	expectedRefs: [],
	expectedTitles: [],
	nearestFalseFriendRefs: [],
	tags: [],
	legacy: null,
	...over,
});

/** Test double: echoes the public searchTask. Not an LLM, not a product query rule. */
function echoModel(onInput: (input: unknown) => void) {
	const receipts = new Set<string>();
	return {
		complete: async (
			input: Parameters<ReturnType<typeof recordedInference>["complete"]>[0],
		) => {
			onInput(structuredClone(input));
			const receipt = crypto.randomUUID();
			receipts.add(receipt);
			return {
				value: { query: (input.data as { searchTask: string }).searchTask },
				receipt,
				inputTokens: null,
				outputTokens: null,
			};
		},
		validReceipt: (_tx: unknown, r: string) => receipts.has(r),
	};
}

test("--query-reformulation is strict and off by default", () => {
	expect(parseQueryReformulation([])).toBe("off");
	expect(parseQueryReformulation(["--query-reformulation", "on"])).toBe("on");
	expect(parseQueryReformulation(["--query-reformulation", "off"])).toBe("off");
	for (const args of [
		["--query-reformulation"],
		["--query-reformulation", "multi"],
	])
		expect(() => parseQueryReformulation(args)).toThrow(
			"unknown --query-reformulation",
		);
});

test("canary: aux model input and DB query depend only on the public searchTask", async () => {
	const runs: { aux: unknown[]; db: string[] }[] = [];
	for (const internal of [
		`内部タスク ${CANARY} 秘密の制約`,
		"内部タスク 別の内部文字列",
	]) {
		const f = setup();
		const aux: unknown[] = [];
		const db: string[] = [];
		const spied = {
			...f.source,
			search: (q: string, limit: number, signal: AbortSignal) => {
				db.push(q);
				return f.source.search(q, limit, signal);
			},
		};
		const source = createReformulatingSource(
			spied,
			echoModel((i) => aux.push(i)),
			{ deadlineAt },
		);
		// Same public searchTask; only the internal goal (with canary) differs.
		const host = createExampleHost(source, "検証", undefined, {
			goal: internal,
			modelCalls: 2,
		});
		try {
			await host.run();
		} finally {
			host.close();
		}
		runs.push({ aux, db });
	}
	const [a, b] = runs;
	expect(a!.aux.length).toBeGreaterThan(0);
	expect(a!.aux).toEqual(b!.aux);
	expect(a!.db).toEqual(b!.db);
	for (const run of runs) {
		const text = JSON.stringify(run);
		expect(text).not.toContain(CANARY);
		expect(text).not.toContain("内部タスク");
		expect(text).not.toContain("コピー元"); // host constraint text
		expect(text).not.toContain("外部根拠"); // host acceptance text
		for (const input of run.aux as { data: object; system: string }[]) {
			// Core still sends authority.searchTask; wrapper forwards only that.
			expect(input.data).toEqual({ searchTask: "検証" });
			expect(input.system).toBe(REFORMULATION_INSTRUCTIONS);
		}
		expect(run.db.every((q) => q === "検証")).toBe(true);
	}
});

test("wrapper sends the model's query to the DB and traces it", async () => {
	const f = setup();
	const db: string[] = [];
	const traces: unknown[] = [];
	const record = {
		inputDigest: inferenceTask({
			system: REFORMULATION_INSTRUCTIONS,
			data: { searchTask: "公開タスク" },
			schema: reformulationOutputSchema,
			requestRef: "query-reformulation",
			maxOutputTokens: 120,
			deadlineAt,
		}).inputDigest,
		value: { query: "検証" },
		provider: "test-double",
	};
	const source = createReformulatingSource(
		{
			...f.source,
			search: (q, l, s) => (db.push(q), f.source.search(q, l, s)),
		},
		recordedInference([record]),
		{ deadlineAt, onTrace: (t) => traces.push(t) },
	);
	const { cards } = await source.search("公開タスク", 8, f.signal);
	expect(db).toEqual(["検証"]);
	expect(traces).toEqual([{ searchTask: "公開タスク", queryToSource: "検証" }]);
	expect(cards.length).toBeGreaterThan(0);
});

test("default off: identity has no reformulation digests; retrieval path is the plain source", async () => {
	const f = setup();
	const first = (await f.source.search("検証", 1, f.signal)).cards[0]!.ref;
	const rows = await runRetrievalOnly(
		[task({ expectedRefs: [first], expectedTitles: ["x"] })],
		f.source,
	);
	expect(rows[0]!.ranks).toEqual([{ ref: first, rank: 1 }]);
	const paths = {
		searchProfile: "handle" as const,
		suiteId: "s",
		suitePath: "examples/contextstill/scenarios/suite.json",
		seedPath: "examples/contextstill/scenarios/suite.json",
	};
	const off = buildEvalIdentity(paths);
	const on = buildEvalIdentity({ ...paths, queryReformulation: "on" });
	expect(off.queryReformulation).toBe("off");
	expect(off.reformulationInstructionsDigest).toBeNull();
	expect(on.reformulationInstructionsDigest).not.toBeNull();
	expect(on.reformulationSchemaDigest).not.toBeNull();
	expect(off.buildInstructionsDigest).toBe(on.buildInstructionsDigest);
});

function pendingSetup() {
	const f = setup();
	const db: string[] = [];
	let collected: ReturnType<typeof inferenceTask>[] = [];
	const source = createReformulatingSource(
		{
			...f.source,
			search: (q, l, s) => (db.push(q), f.source.search(q, l, s)),
		},
		recordedInference([], (t) => collected.push(t)),
		{ deadlineAt },
	);
	const ledger = {
		drain: () => {
			const out = collected;
			collected = [];
			return out;
		},
		hasRecord: () => false,
	};
	return { source, ledger, db };
}

test("missing reformulation record goes pending and never invents a query (full)", async () => {
	const { source, ledger, db } = pendingSetup();
	let created = 0;
	const result = await runFull({
		tasks: [task({ id: "p" })],
		source,
		createInference: (_r, onTask) => (created++, recordedInference([], onTask)),
		hasBuildRecord: () => false,
		reformulation: ledger,
	});
	expect(db).toEqual([]);
	expect(created).toBe(0);
	expect(result.complete).toBe(false);
	expect(result.meanScore).toBeNull();
	expect(result.statuses[0]!.status).toBe("awaiting_reformulation_inference");
	expect(result.pendingReformulation).toHaveLength(1);
	expect(result.pendingReformulation[0]!.tasks[0]!.data).toEqual({
		searchTask: "検証",
	});
	expect(result.usage.reformulationInferenceTasks).toBe(1);
	expect(result.usage.inputTokens).toBeNull();
	expect(result.usage.outputTokens).toBeNull();
});

test("missing reformulation record goes pending in retrieval-only", async () => {
	const { source, ledger, db } = pendingSetup();
	const pending: PendingReformulation[] = [];
	const rows = await runRetrievalOnly([task()], source, ledger, pending);
	expect(db).toEqual([]);
	expect(rows[0]!.error).toBe("reformulation_record_missing");
	expect(pending).toHaveLength(1);
});
