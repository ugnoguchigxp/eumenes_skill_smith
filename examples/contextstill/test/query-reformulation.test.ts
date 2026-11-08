import {
	createMultiQuerySource,
	MULTI_QUERY_INSTRUCTIONS,
} from "../multi-query.js";
import { expect, test } from "bun:test";
import { createExampleHost } from "../host.js";
import {
	REFORMULATION_INSTRUCTIONS,
	containsJapanese,
	createAutoReformulatingSource,
	createLegacyAutoReformulatingSource,
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
import { setup, item, handle } from "./fixture.js";

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
function echoModel(onInput: (input: unknown) => void, multi = false) {
	const receipts = new Set<string>();
	return {
		complete: async (
			input: Parameters<ReturnType<typeof recordedInference>["complete"]>[0],
		) => {
			onInput(structuredClone(input));
			const receipt = crypto.randomUUID();
			receipts.add(receipt);
			return {
				value: multi
					? { queries: [(input.data as { searchTask: string }).searchTask] }
					: { query: (input.data as { searchTask: string }).searchTask },
				receipt,
				inputTokens: null,
				outputTokens: null,
			};
		},
		validReceipt: (_tx: unknown, r: string) => receipts.has(r),
	};
}

test("--query-reformulation is strict and auto by default", () => {
	expect(parseQueryReformulation([])).toBe("auto");
	expect(parseQueryReformulation(["--query-reformulation", "multi"])).toBe(
		"multi",
	);
	expect(parseQueryReformulation(["--query-reformulation", "on"])).toBe("on");
	expect(parseQueryReformulation(["--query-reformulation", "off"])).toBe("off");
	for (const args of [
		["--query-reformulation"],
		["--query-reformulation", "unknown"],
	])
		expect(() => parseQueryReformulation(args)).toThrow(
			"unknown --query-reformulation",
		);
});

for (const multi of [false, true]) {
	test(`${multi ? "multi" : "single"} canary: aux model input and DB query depend only on the public searchTask`, async () => {
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
			const wrap = multi ? createMultiQuerySource : createReformulatingSource;
			const source = wrap(
				spied,
				echoModel((i) => aux.push(i), multi),
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
				expect(input.system).toBe(
					multi ? MULTI_QUERY_INSTRUCTIONS : REFORMULATION_INSTRUCTIONS,
				);
			}
			expect(run.db.every((q) => q === "検証")).toBe(true);
		}
	});
}

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

function pendingSetup(multi: boolean) {
	const f = setup();
	const db: string[] = [];
	let collected: ReturnType<typeof inferenceTask>[] = [];
	const wrap = multi ? createMultiQuerySource : createReformulatingSource;
	const source = wrap(
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

for (const multi of [false, true]) {
	test(`${multi ? "multi" : "single"} missing reformulation record goes pending and never invents a query (full)`, async () => {
		const { source, ledger, db } = pendingSetup(multi);
		let created = 0;
		const result = await runFull({
			assemblyMode: "legacy",
			tasks: [task({ id: "p" })],
			source,
			createInference: (_r, onTask) => (
				created++,
				recordedInference([], onTask)
			),
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

	test(`${multi ? "multi" : "single"} missing reformulation record goes pending in retrieval-only`, async () => {
		const { source, ledger, db } = pendingSetup(multi);
		const pending: PendingReformulation[] = [];
		const rows = await runRetrievalOnly([task()], source, ledger, pending);
		expect(db).toEqual([]);
		expect(rows[0]!.error).toBe("reformulation_record_missing");
		expect(pending).toHaveLength(1);
	});
}

test("parse: omitted is auto; auto/off/on explicit; unknown errors", () => {
	expect(parseQueryReformulation([])).toBe("auto");
	for (const v of ["off", "on", "auto", "multi"] as const)
		expect(parseQueryReformulation(["--query-reformulation", v])).toBe(v);
	expect(() => parseQueryReformulation(["--query-reformulation", "x"])).toThrow(
		"unknown --query-reformulation",
	);
});

test("archival auto fires on Japanese and non-title English, skips normalized title matches", async () => {
	expect(containsJapanese("APIキー")).toBe(true);
	expect(containsJapanese("ｶﾀｶﾅ")).toBe(true);
	expect(containsJapanese("検証")).toBe(true);
	expect(containsJapanese("Never commit secrets")).toBe(false);
	const f = setup([item({ title: "Never commit secrets" })]);
	const inputs: unknown[] = [];
	const db: string[] = [];
	let fired = 0;
	const inner = {
		...f.source,
		search: (q: string, l: number, s: AbortSignal) => (
			db.push(q),
			f.source.search(q, l, s)
		),
	};
	const source = createLegacyAutoReformulatingSource(
		inner,
		createReformulatingSource(
			inner,
			echoModel((i) => inputs.push(i)),
			{ deadlineAt },
		),
		() => fired++,
	);
	await source.search("  ＮＥＶＥＲ commit SECRETS  ", 8, f.signal);
	expect(fired).toBe(0);
	expect(inputs).toEqual([]);
	await source.search(`APIキー ${CANARY}`, 8, f.signal);
	expect(fired).toBe(1);
	expect(inputs).toHaveLength(1);
	expect((inputs[0] as { data: unknown }).data).toEqual({
		searchTask: `APIキー ${CANARY}`,
	});
	expect(db).toEqual(["  ＮＥＶＥＲ commit SECRETS  ", `APIキー ${CANARY}`]);
	await source.search("Keep my credentials out of git", 8, f.signal);
	expect(fired).toBe(2);
	expect(inputs).toHaveLength(2);
	expect((inputs[1] as { data: unknown }).data).toEqual({
		searchTask: "Keep my credentials out of git",
	});
});

test("archival auto does not skip reformulation for a filtered-out title", async () => {
	const f = setup([
		item({ title: "Hidden title", handle: handle("c"), status: "superseded" }),
	]);
	const inputs: unknown[] = [];
	const source = createLegacyAutoReformulatingSource(
		f.source,
		createReformulatingSource(
			f.source,
			echoModel((i) => inputs.push(i)),
			{ deadlineAt },
		),
	);
	await source.search("Hidden title", 8, f.signal);
	expect(inputs).toHaveLength(1);
});

test("archival M3 auto reserves two physical searches plus one shared auxiliary call and memoizes only query", async () => {
	const f = setup();
	let model = 0;
	const counts = { modelCalls: 0, sourceCalls: 0 };
	const ledger: any[] = [];
	const aux = createReformulatingSource(
		f.source,
		echoModel(() => model++),
		{ deadlineAt },
	);
	const source = createLegacyAutoReformulatingSource(f.source, aux);
	const context = {
		signal: f.signal,
		reserve: async (kind: "modelCalls" | "sourceCalls") => {
			counts[kind]++;
		},
		noteCall: (call: any) => ledger.push(call),
	};
	await source.search("non title", 1, f.signal, context);
	await source.search("non title", 1, f.signal, context);
	expect(model).toBe(1);
	expect(ledger.find((x) => x.kind === "modelCalls").inputTokens).toBeNull();
	expect(ledger.find((x) => x.kind === "modelCalls").receipt).toBeString();
	expect(counts).toEqual({ modelCalls: 1, sourceCalls: 4 });
	expect(ledger.filter((x) => x.kind === "sourceCalls")).toHaveLength(4);
});
test("archival M3 exhausted shared model budget prevents auxiliary provider call and rewritten search", async () => {
	const f = setup();
	let model = 0;
	let sourceCalls = 0;
	const source = createLegacyAutoReformulatingSource(
		f.source,
		createReformulatingSource(
			f.source,
			echoModel(() => model++),
			{ deadlineAt },
		),
	);
	await expect(
		source.search("non title", 1, f.signal, {
			signal: f.signal,
			reserve: async (kind) => {
				if (kind === "modelCalls") throw new Error("budget_exceeded");
				sourceCalls++;
			},
		}),
	).rejects.toThrow("budget_exceeded");
	expect(model).toBe(0);
	expect(sourceCalls).toBe(1);
});
test("M3 validate reserves every get and stops at shared source cap", async () => {
	const f = setup();
	const refs = (await f.source.search("検証", 2, f.signal)).cards;
	let calls = 0;
	const ledger: any[] = [];
	await expect(
		f.source.validate(refs, f.signal, {
			signal: f.signal,
			reserve: async () => {
				if (calls >= 1) throw new Error("budget_exceeded");
				calls++;
			},
			noteCall: (call) => ledger.push(call),
		}),
	).rejects.toThrow("budget_exceeded");
	expect(calls).toBe(1);
	expect(ledger).toHaveLength(1);
});
test("M3 core and auxiliary share model cap, without raising existing limit", async () => {
	const f = setup();
	let auxCalls = 0;
	let builderCalls = 0;
	const source = createReformulatingSource(
		f.source,
		echoModel(() => auxCalls++),
		{ deadlineAt },
	);
	const host = createExampleHost(
		source,
		"検証",
		echoModel(() => builderCalls++),
		{ modelCalls: 1 },
	);
	try {
		await expect(host.run()).rejects.toThrow("budget_exceeded");
		expect(auxCalls).toBe(1);
		expect(builderCalls).toBe(0);
		expect(host.request.limits.modelCalls).toBe(1);
	} finally {
		host.close();
	}
});

test("current auto sends every language and exact title to one LLM query chooser", async () => {
	const f = setup([item({ title: "Never commit secrets" })]),
		inputs: unknown[] = [],
		queries: string[] = [];
	const inner = {
		...f.source,
		search: (q: string, l: number, s: AbortSignal) => (
			queries.push(q),
			f.source.search(q, l, s)
		),
	};
	const source = createAutoReformulatingSource(
		inner,
		createReformulatingSource(
			inner,
			echoModel((i) => inputs.push(i)),
			{ deadlineAt },
		),
	);
	const tasks = [
		"Never commit secrets",
		"入力の検証",
		"Validar entrada",
		"Eingaben pruefen",
	];
	for (const query of tasks) await source.search(query, 8, f.signal);
	expect(inputs.map((i) => (i as { data: unknown }).data)).toEqual(
		tasks.map((searchTask) => ({ searchTask })),
	);
	expect(queries).toEqual(tasks);
});

test("current auto avoids speculative source I/O and retains memoized one-query accounting", async () => {
	const f = setup(),
		counts = { modelCalls: 0, sourceCalls: 0 };
	let model = 0;
	const source = createAutoReformulatingSource(
		f.source,
		createReformulatingSource(
			f.source,
			echoModel(() => model++),
			{ deadlineAt },
		),
	);
	const context = {
		signal: f.signal,
		reserve: async (kind: "modelCalls" | "sourceCalls") => {
			counts[kind]++;
		},
	};
	await source.search("one public query", 1, f.signal, context);
	await source.search("one public query", 1, f.signal, context);
	expect(model).toBe(1);
	expect(counts).toEqual({ modelCalls: 1, sourceCalls: 2 });
	let sourceCalls = 0;
	await expect(
		source.search("another public query", 1, f.signal, {
			signal: f.signal,
			reserve: async (kind) => {
				if (kind === "modelCalls") throw Error("budget_exceeded");
				sourceCalls++;
			},
		}),
	).rejects.toThrow("budget_exceeded");
	expect(sourceCalls).toBe(0);
});
