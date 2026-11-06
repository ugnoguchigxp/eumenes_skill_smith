import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	allRequiredHit,
	builderView,
	parseAnyScenarioSuite,
	refRanks,
	retrievalRank,
	typedScenarioTaskSchema,
	scenarioSuiteSchema,
	scoreFromJudge,
} from "../eval/index.js";

const suite = scenarioSuiteSchema.parse(
	JSON.parse(
		readFileSync("examples/contextstill/scenarios/suite.json", "utf8"),
	),
);

test("scenario suite names expected seed skills", () => {
	expect(suite.id).toBe("seed-skill-assembly");
	expect(suite.tasks.map((task) => task.id)).toEqual([
		"commit-no-secrets",
		"test-production-clone",
		"no-secrets-in-logs",
		"no-hook-bypass",
		"four-space-indent",
	]);
	for (const task of suite.tasks) {
		expect(task.expectedRefs[0]?.startsWith("contextstill:kn_")).toBe(true);
	}
});

test("retrievalRank is 1-based and null when the expected skill is absent", () => {
	const cards = [
		{ ref: "contextstill:kn_other" },
		{ ref: "contextstill:kn_23jihzqdoyhkbsnfs7a6p4brjq" },
	];
	expect(
		retrievalRank(cards, ["contextstill:kn_23jihzqdoyhkbsnfs7a6p4brjq"]),
	).toBe(2);
	expect(retrievalRank(cards, ["contextstill:kn_missing"])).toBeNull();
});

test("scoreFromJudge keeps the LLM score and does not invent one", () => {
	const scored = scoreFromJudge(
		suite.tasks[0]!,
		{
			retrievalRank: 2,
			usedRefs: ["contextstill:kn_23jihzqdoyhkbsnfs7a6p4brjq"],
			strategy: "reuse",
			kind: "ready",
		},
		{
			score: 9,
			expectedSkillUsed: true,
			rationale: "期待Skillを選び、秘密情報をコミットしない手順になっている。",
		},
	);
	expect(scored.score).toBe(9);
	expect(scored.judge).toBe("llm");
	expect(scored.expectedSkillUsed).toBe(true);
	expect(scored.retrievalRank).toBe(2);
});

const typedRaw = JSON.parse(
	readFileSync("examples/contextstill/scenarios/suite-3axis.json", "utf8"),
) as { tasks: Record<string, unknown>[] };

test("parseAnyScenarioSuite accepts the legacy and typed three-axis suites", () => {
	const legacy = parseAnyScenarioSuite(
		JSON.parse(
			readFileSync("examples/contextstill/scenarios/suite.json", "utf8"),
		),
	);
	expect(legacy.format).toBe("legacy");
	expect(legacy.tasks.every((t) => t.legacy && t.axis === "retrieval")).toBe(
		true,
	);
	const typed = parseAnyScenarioSuite(typedRaw);
	expect(typed.format).toBe("typed");
	expect(typed.tasks).toHaveLength(61);
	const count = (axis: string) =>
		typed.tasks.filter((t) => t.axis === axis).length;
	expect([count("retrieval"), count("compose"), count("absent")]).toEqual([
		53, 4, 4,
	]);
	// The comparison slice keeps the original goals unchanged.
	const original = new Map(legacy.tasks.map((t) => [t.id, t.goal]));
	for (const t of typed.tasks.filter((t) =>
		t.tags.includes("comparison-slice"),
	))
		expect(t.goal).toBe(original.get(t.id)!);
});

test("empty expected refs are allowed only on the absent axis", () => {
	const absent = typedRaw.tasks.find((t) => t.axis === "absent")!;
	const retrieval = typedRaw.tasks.find((t) => t.axis === "retrieval")!;
	const compose = typedRaw.tasks.find((t) => t.axis === "compose")!;
	expect(typedScenarioTaskSchema.safeParse(absent).success).toBe(true);
	for (const t of [retrieval, compose])
		expect(
			typedScenarioTaskSchema.safeParse({
				...t,
				expectedRefs: [],
				expectedTitles: [],
			}).success,
		).toBe(false);
	expect(
		typedScenarioTaskSchema.safeParse({
			...absent,
			expectedRefs: ["contextstill:kn_x"],
		}).success,
	).toBe(false);
	// Compose needs at least two intents.
	expect(
		typedScenarioTaskSchema.safeParse({
			...compose,
			expectedRefs: ["contextstill:kn_x"],
			expectedTitles: ["x"],
		}).success,
	).toBe(false);
});

test("allRequiredHit needs every ref; first-hit rank is not success for compose", () => {
	const cards = [{ ref: "a" }, { ref: "b" }, { ref: "c" }];
	const ranks = refRanks(cards, ["b", "z"]);
	expect(ranks).toEqual([
		{ ref: "b", rank: 2 },
		{ ref: "z", rank: null },
	]);
	expect(retrievalRank(cards, ["b", "z"])).toBe(2);
	expect(allRequiredHit(ranks, 8)).toBe(false);
	expect(allRequiredHit(refRanks(cards, ["a", "c"]), 8)).toBe(true);
	expect(allRequiredHit(refRanks(cards, ["a", "c"]), 2)).toBe(false);
	// Absent: N/A, never a perfect 0/0.
	expect(allRequiredHit(refRanks(cards, []), 8)).toBeNull();
});

test("builder view carries no gold labels", () => {
	const typed = parseAnyScenarioSuite(typedRaw);
	for (const task of typed.tasks) {
		const view = JSON.stringify(builderView(task));
		expect(Object.keys(builderView(task)).sort()).toEqual([
			"acceptance",
			"goal",
		]);
		for (const ref of task.expectedRefs) expect(view.includes(ref)).toBe(false);
	}
});
