import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	buildEvalIdentity,
	parseAssemblyMode,
	runFull,
	runRetrievalOnly,
} from "../scenario-runner.js";
import { inferenceTask, recordedInference } from "../recorded.js";
import type { NormalizedScenarioTask } from "../../../src/eval/scenario-score.js";
import { ContextStillFixture } from "../database.js";
import { createMcpHandler } from "../mcp.js";
import { createFixtureSource } from "../source.js";
import { parseAnyScenarioSuite } from "../../../src/eval/scenario-score.js";
import { handle, setup } from "./fixture.js";

const task = (
	over: Partial<NormalizedScenarioTask>,
): NormalizedScenarioTask => ({
	id: "t",
	axis: "retrieval",
	queryStyle: "exact",
	goal: "検証",
	acceptance: [{ id: "a", text: "x" }],
	expectedRefs: [],
	expectedTitles: [],
	nearestFalseFriendRefs: [],
	tags: [],
	legacy: null,
	...over,
});

/** Fixture build model: same shape as createExampleHost's default wiring inference. */
function wiringBuild(onTask: (task: ReturnType<typeof inferenceTask>) => void) {
	const receipts = new Set<string>();
	return {
		complete: async (
			input: Parameters<ReturnType<typeof recordedInference>["complete"]>[0],
			signal: AbortSignal,
		) => {
			signal.throwIfAborted();
			onTask(inferenceTask(input));
			const index = (
				input.data as {
					evidenceIndex: {
						ref: string;
						status: string;
						complete: boolean;
					}[];
				}
			).evidenceIndex;
			const card = index?.find((e) => e.status === "active" && e.complete);
			const receipt = crypto.randomUUID();
			receipts.add(receipt);
			return {
				value: card
					? {
							kind: "ready",
							strategy: "compose",
							sourceRefs: [card.ref],
							sections: [
								{
									id: "wiring-only",
									body: "固定モデルによる接続確認。実作業の指針として使用しない。",
								},
							],
							patches: [],
							requiredCapabilities: [],
							verification: ["取得した依存版を再検査する"],
							assumptions: [],
						}
					: { kind: "unavailable", code: "fixture_no_complete_evidence" },
				receipt,
				inputTokens: null,
				outputTokens: null,
			};
		},
		validReceipt: (_tx: unknown, receipt: string) => receipts.has(receipt),
	};
}

test("retrieval-only makes zero inference calls and reports per-ref ranks", async () => {
	const f = setup();
	// The runner takes no inference port; spy the SourcePort to prove it only searches
	// (a builder or judge run would also call get/validate).
	const calls: string[] = [];
	const source = {
		search: (...a: Parameters<typeof f.source.search>) => (
			calls.push("search"),
			f.source.search(...a)
		),
		get: (...a: Parameters<typeof f.source.get>) => (
			calls.push("get"),
			f.source.get(...a)
		),
		validate: (...a: Parameters<typeof f.source.validate>) => (
			calls.push("validate"),
			f.source.validate(...a)
		),
	};
	const first = (await f.source.search("検証", 1, f.signal)).cards[0]!.ref;
	const rows = await runRetrievalOnly(
		[
			task({ id: "hit", expectedRefs: [first], expectedTitles: ["x"] }),
			task({
				id: "compose",
				axis: "compose",
				queryStyle: null,
				expectedRefs: [first, `contextstill:${handle("z")}`],
				expectedTitles: ["x", "y"],
			}),
			task({ id: "absent", axis: "absent", queryStyle: null }),
		],
		source,
	);
	expect(calls).toEqual(["search", "search", "search"]);
	expect(rows.map((r) => r.allRequiredHitAt8)).toEqual([true, false, null]);
	expect(rows[1]!.ranks[0]!.rank).toBe(1);
	expect(rows[1]!.ranks[1]!.rank).toBeNull();
});

test("full mode with missing records is incomplete and withholds the mean", async () => {
	const f = setup();
	let created = 0;
	const result = await runFull({
		assemblyMode: "legacy",
		tasks: [
			task({
				id: "p",
				expectedRefs: ["contextstill:kn_x"],
				expectedTitles: ["x"],
			}),
		],
		source: f.source,
		createInference: (_role, onTask) => {
			created++;
			return recordedInference([], onTask);
		},
		hasBuildRecord: () => false,
	});
	expect(created).toBeGreaterThan(0);
	expect(result.complete).toBe(false);
	expect(result.meanScore).toBeNull();
	expect(result.statuses[0]!.status).toBe("awaiting_build_inference");
	expect(result.usage.inputTokens).toBeNull();
	expect(result.usage.outputTokens).toBeNull();
});

test("source.search throw isolates to one status row; later tasks still run", async () => {
	const f = setup();
	let searches = 0;
	const source = {
		search: async (...a: Parameters<typeof f.source.search>) => {
			searches++;
			if (searches === 1) throw new Error("source_boom");
			return f.source.search(...a);
		},
		get: f.source.get.bind(f.source),
		validate: f.source.validate.bind(f.source),
	};
	const result = await runFull({
		assemblyMode: "legacy",
		tasks: [
			task({
				id: "boom",
				expectedRefs: ["contextstill:a"],
				expectedTitles: ["a"],
			}),
			task({
				id: "later",
				expectedRefs: ["contextstill:b"],
				expectedTitles: ["b"],
			}),
		],
		source,
		createInference: (_role, onTask) => recordedInference([], onTask),
		hasBuildRecord: () => false,
	});
	expect(result.statuses).toHaveLength(2);
	expect(result.statuses[0]).toMatchObject({
		taskId: "boom",
		status: "error",
		detail: "source_boom",
	});
	expect(result.statuses[1]!.status).toBe("awaiting_build_inference");
	expect(result.complete).toBe(false);
	expect(result.meanScore).toBeNull();
	expect(result.scores).toEqual([]);
});

test("invalid judge value is status invalid; other tasks can still score; mean withheld", async () => {
	const f = setup();
	const first = (await f.source.search("検証", 1, f.signal)).cards[0]!.ref;
	const result = await runFull({
		assemblyMode: "legacy",
		tasks: [
			task({
				id: "good",
				goal: "検証",
				expectedRefs: [first],
				expectedTitles: ["x"],
			}),
			task({
				id: "bad",
				goal: "検証",
				expectedRefs: [first],
				expectedTitles: ["x"],
			}),
		],
		source: f.source,
		createInference: (role, onTask) => {
			if (role === "build") return wiringBuild(onTask);
			const receipts = new Set<string>();
			return {
				complete: async (input, signal) => {
					signal.throwIfAborted();
					onTask(inferenceTask(input));
					const receipt = crypto.randomUUID();
					receipts.add(receipt);
					const invalid = input.requestRef.includes("bad");
					return {
						value: invalid
							? { score: 99, expectedSkillUsed: "yes", rationale: "" }
							: {
									score: 8,
									expectedSkillUsed: true,
									rationale: "配線試験の妥当な評点本文",
								},
						receipt,
						inputTokens: null,
						outputTokens: null,
					};
				},
				validReceipt: (_tx, receipt) => receipts.has(receipt),
			};
		},
		hasBuildRecord: () => true,
	});
	expect(result.statuses).toHaveLength(2);
	const byId = Object.fromEntries(
		result.statuses.map((s) => [s.taskId, s.status]),
	);
	expect(byId.good).toBe("scored");
	expect(byId.bad).toBe("invalid");
	expect(result.scores).toHaveLength(1);
	expect(result.scores[0]!.taskId).toBe("good");
	expect(result.scores[0]!.score).toBe(8);
	expect(result.complete).toBe(false);
	expect(result.meanScore).toBeNull();
	const badProv = result.recordProvenance.find((p) => p.taskId === "bad")!;
	expect(badProv.judgeInputDigest).not.toBeNull();
	expect(badProv.judgeRecordPresent).toBe(true);
	expect(result.usage.inputTokens).toBeNull();
	expect(result.usage.outputTokens).toBeNull();
});

test("parseAssemblyMode defaults to baseline and rejects unknown values", () => {
	expect(parseAssemblyMode([])).toBe("baseline");
	expect(parseAssemblyMode(["--assembly-mode", "baseline"])).toBe("baseline");
	expect(parseAssemblyMode(["--assembly-mode", "compact"])).toBe("compact");
	for (const args of [["--assembly-mode"], ["--assembly-mode", "fast"]])
		expect(() => parseAssemblyMode(args)).toThrow("unknown --assembly-mode");
});

test("buildEvalIdentity populates profile, assemblyMode, file hashes, and instruction digests", () => {
	const suitePath = resolve("examples/contextstill/scenarios/suite.json");
	const seedPath = resolve("data/contextstill/seed.sqlite");
	const identity = buildEvalIdentity({
		searchProfile: "handle",
		suiteId: "seed-skill-assembly",
		suitePath,
		seedPath,
	});
	expect(identity.searchProfile).toBe("handle");
	expect(identity.assemblyMode).toBe("baseline");
	expect(identity.suiteId).toBe("seed-skill-assembly");
	expect(identity.suiteFileSha256).toMatch(/^[a-f0-9]{64}$/);
	expect(identity.seedFileSha256).toMatch(/^[a-f0-9]{64}$/);
	expect(identity.buildInstructionsDigest).toMatch(/^[a-f0-9]{64}$/);
	expect(identity.judgeInstructionsDigest).toMatch(/^[a-f0-9]{64}$/);
	expect(identity.judgeSchemaDigest).toMatch(/^[a-f0-9]{64}$/);
	expect(identity.suiteFileSha256).not.toBe(identity.seedFileSha256);
	const compact = buildEvalIdentity({
		searchProfile: "handle",
		assemblyMode: "compact",
		suiteId: "seed-skill-assembly",
		suitePath,
		seedPath,
	});
	expect(compact.assemblyMode).toBe("compact");
	expect(compact.buildInstructionsDigest).not.toBe(
		identity.buildInstructionsDigest,
	);
});

test("handle-profile records under bm25 do not silently reuse as scored", async () => {
	const suite = parseAnyScenarioSuite(
		JSON.parse(
			readFileSync("examples/contextstill/scenarios/suite.json", "utf8"),
		),
	);
	const buildRecords = JSON.parse(
		readFileSync("examples/contextstill/scenarios/build-records.json", "utf8"),
	) as { inputDigest: string; value: unknown; provider: string }[];
	const judgeRecords = JSON.parse(
		readFileSync("examples/contextstill/scenarios/judge-records.json", "utf8"),
	) as { inputDigest: string; value: unknown; provider: string }[];
	const fixture = new ContextStillFixture(
		"data/contextstill/seed.sqlite",
		"bm25",
	);
	const token = crypto.randomUUID();
	const source = createFixtureSource(createMcpHandler(fixture, token), token);
	try {
		const result = await runFull({
			assemblyMode: "legacy",
			tasks: suite.tasks,
			source,
			createInference: (role, onTask) =>
				recordedInference(
					role === "build" ? buildRecords : judgeRecords,
					onTask,
				),
			hasBuildRecord: (d) => buildRecords.some((r) => r.inputDigest === d),
		});
		expect(result.complete).toBe(false);
		expect(result.meanScore).toBeNull();
		expect(result.scores).toEqual([]);
		expect(
			result.statuses.every(
				(s) =>
					s.status === "awaiting_build_inference" ||
					s.status === "awaiting_judge" ||
					s.status === "error",
			),
		).toBe(true);
		expect(
			result.statuses.some((s) => s.status === "awaiting_build_inference"),
		).toBe(true);
		expect(result.statuses.some((s) => s.status === "scored")).toBe(false);
	} finally {
		fixture.close();
	}
});

test("diverse companion loads independently without expanding the 61-task scoreboard", () => {
	const load = (name: string) =>
		parseAnyScenarioSuite(
			JSON.parse(
				readFileSync(
					resolve(`examples/contextstill/scenarios/${name}.json`),
					"utf8",
				),
			),
		);
	const main = load("suite-3axis");
	const diverse = load("suite-diverse");
	expect(main.tasks).toHaveLength(61);
	expect(diverse.tasks).toHaveLength(10);
	expect(diverse.id).not.toBe(main.id);
	for (const task of diverse.tasks) {
		expect(task.axis).toBe("retrieval");
		expect(task.tags).toContain("diverse-probe");
		const exact = main.tasks.find(
			(t) =>
				t.queryStyle === "exact" &&
				JSON.stringify(t.expectedTitles) ===
					JSON.stringify(task.expectedTitles),
		);
		expect(exact).toBeDefined();
		expect(task.expectedRefs).toEqual(exact!.expectedRefs);
		expect(task.acceptance).toEqual(exact!.acceptance);
	}
});

test("M2 current retrieval judge gets judge-only full reference bodies inside untrusted boundary", async () => {
	const f = setup();
	const first = (await f.source.search("検証", 1, f.signal)).cards[0]!;
	const builderInputs: string[] = [];
	let judgeInput: any;
	const source = {
		...f.source,
		get: async (...args: Parameters<typeof f.source.get>) => ({
			...(await f.source.get(...args)),
			body: "JUDGE_ONLY_REFERENCE_BODY",
		}),
	};
	const r = await runFull({
		tasks: [
			task({
				id: "judge-boundary",
				goal: "検証",
				expectedRefs: [first.ref],
				expectedTitles: [first.title],
			}),
		],
		source,
		hasBuildRecord: () => true,
		createInference: (role, onTask) => ({
			complete: async (input) => {
				onTask(inferenceTask(input));
				if (role === "build") builderInputs.push(JSON.stringify(input));
				else judgeInput = input;
				return {
					value:
						role === "build"
							? { kind: "needs_input", missing: ["対象を指定してください"] }
							: {
									score: 1,
									expectedSkillUsed: false,
									rationale: "synthetic test only",
									correctness: 1,
									actionability: 1,
									essentialCoverage: 1,
									incorrectSteps: [],
									nameSelection: 1,
									constraintPreservation: 2,
									sourceFaithfulness: 3,
									executionOutcome: null,
								},
					receipt: "test",
					inputTokens: null,
					outputTokens: null,
				};
			},
			validReceipt: () => true,
		}),
	});
	expect(r.complete).toBe(true);
	expect(r.deliveryOutcomes).toEqual([
		{ taskId: "judge-boundary", kind: "needs_input" },
	]);
	expect(builderInputs.join("")).not.toContain("JUDGE_ONLY_REFERENCE_BODY");
	expect(judgeInput.data.untrustedJudgeData.instructionAuthority).toBe("none");
	expect(
		judgeInput.data.untrustedJudgeData.data.referenceEvidence[0].body,
	).toBe("JUDGE_ONLY_REFERENCE_BODY");
	expect(judgeInput.data.untrustedJudgeData.data.finalArtifact).toBeNull();
	expect(r.retrievalFidelityScores[0]).toMatchObject({
		nameSelection: 1,
		constraintPreservation: 2,
		sourceFaithfulness: 3,
		executionOutcome: null,
	});
});
