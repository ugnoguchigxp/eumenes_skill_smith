import { test, expect } from "bun:test";
import {
	fidelityJudgeSchema,
	CURRENT_JUDGE_INSTRUCTIONS,
	QUALITY_JUDGE_VERSION,
} from "../eval/scenario-score.js";
import { composeJudgeSchema } from "../../examples/contextstill/compose-isolation.js";
import { absentJudgeSchema } from "../../examples/contextstill/absent-isolation.js";
const base = {
	score: 8,
	expectedSkillUsed: true,
	rationale: "synthetic",
	correctness: 8,
	actionability: 8,
	essentialCoverage: 8,
	incorrectSteps: [],
};
for (const [schema, extra] of [
	[
		fidelityJudgeSchema,
		{
			nameSelection: 8,
			constraintPreservation: 8,
			sourceFaithfulness: 8,
			executionOutcome: null,
		},
	],
	[composeJudgeSchema, { coverage: 8, coherence: 8, conflictHandling: 8 }],
	[
		absentJudgeSchema,
		{
			boundedExploration: 8,
			inventsOfficialSkill: false,
			claimsVerified: false,
		},
	],
] as const) {
	test(
		"strict judge requires separate correctness and enforces error cap " +
			Object.keys(extra).join(","),
		() => {
			const value = { ...base, ...extra };
			expect(schema.safeParse(value).success).toBe(true);
			expect(
				schema.safeParse({ ...value, incorrectSteps: ["bad API"] }).success,
			).toBe(false);
			expect(
				schema.safeParse({ ...value, score: 5, incorrectSteps: ["bad API"] })
					.success,
			).toBe(true);
			expect(
				schema.safeParse({ ...value, correctness: undefined }).success,
			).toBe(false);
		},
	);
}
test("strict rubric is versioned and distinguishes source fidelity from correctness", () => {
	expect(QUALITY_JUDGE_VERSION).toBe("quality-judge.v2");
	expect(CURRENT_JUDGE_INSTRUCTIONS).toContain("出典自体の誤り");
});
