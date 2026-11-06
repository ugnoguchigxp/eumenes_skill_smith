import { expect, test } from "bun:test";
import {
	compareConditionRuns,
	synthesisNotClearlyBetter,
	type EvalRunResult,
} from "../eval/index.js";

const base = {
	taskId: "task:1",
	usedRefs: [] as string[],
	inputTokens: 10 as number | null,
	outputTokens: 5 as number | null,
	modelCalls: 1,
	sourceCalls: 0,
};

test("comparison encodes deltas without a hardcoded winner", () => {
	const runs: EvalRunResult[] = [
		{
			...base,
			condition: "none",
			kind: "ready",
			judgment: { acceptanceMet: false, misApplied: false, source: "fixture" },
		},
		{
			...base,
			condition: "agent_skills",
			kind: "ready",
			usedRefs: ["skill:a"],
			inputTokens: 20,
			outputTokens: 10,
			judgment: { acceptanceMet: true, misApplied: false, source: "fixture" },
		},
		{
			...base,
			condition: "skillsmith",
			kind: "ready",
			usedRefs: ["skill:a"],
			inputTokens: 40,
			outputTokens: 20,
			judgment: { acceptanceMet: true, misApplied: false, source: "fixture" },
		},
	];
	const cmp = compareConditionRuns(runs);
	expect(cmp.deltas.acceptanceAdvantage).toBe("tie");
	expect(cmp.deltas.misApplicationWorse).toBe("tie");
	expect(cmp.deltas.tokenDeltaSkillsmithVsBaseline).toBe(30);
	expect(synthesisNotClearlyBetter(cmp)).toBe(true);
});

test("skillsmith acceptance lead is visible but falsifiable", () => {
	const runs: EvalRunResult[] = [
		{
			...base,
			condition: "agent_skills",
			kind: "ready",
			judgment: { acceptanceMet: false, misApplied: false, source: "fixture" },
		},
		{
			...base,
			condition: "skillsmith",
			kind: "ready",
			inputTokens: 10,
			outputTokens: 5,
			judgment: { acceptanceMet: true, misApplied: false, source: "fixture" },
		},
	];
	const cmp = compareConditionRuns(runs);
	expect(cmp.deltas.acceptanceAdvantage).toBe("skillsmith");
	expect(synthesisNotClearlyBetter(cmp)).toBe(false);
});

test("unlabeled runs stay incomplete instead of inventing a winner", () => {
	const cmp = compareConditionRuns([
		{ ...base, condition: "agent_skills", kind: "ready" },
		{ ...base, condition: "skillsmith", kind: "ready" },
	]);
	expect(cmp.deltas.acceptanceAdvantage).toBe("incomplete");
	expect(synthesisNotClearlyBetter(cmp)).toBe(true);
});
