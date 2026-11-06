import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	retrievalRank,
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
