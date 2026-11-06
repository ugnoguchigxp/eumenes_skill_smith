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

test("strategy and abstention fields appear in paired A/B/C deltas", () => {
	const cmp = compareConditionRuns([
		{
			taskId: "t1",
			condition: "none",
			kind: "needs_input",
			usedRefs: [],
			missing: ["不足"],
			inputTokens: 1,
			outputTokens: 1,
			modelCalls: 1,
			sourceCalls: 0,
			abstention: { appropriate: true, source: "fixture" },
			judgment: { acceptanceMet: false, misApplied: false, source: "fixture" },
		},
		{
			taskId: "t1",
			condition: "agent_skills",
			kind: "ready",
			usedRefs: ["a"],
			inputTokens: 2,
			outputTokens: 2,
			modelCalls: 1,
			sourceCalls: 0,
			actualStrategy: "reuse",
			judgment: { acceptanceMet: true, misApplied: false, source: "fixture" },
		},
		{
			taskId: "t1",
			condition: "skillsmith",
			kind: "ready",
			usedRefs: ["a"],
			inputTokens: 3,
			outputTokens: 3,
			modelCalls: 2,
			sourceCalls: 1,
			actualStrategy: "compose",
			judgment: { acceptanceMet: true, misApplied: false, source: "fixture" },
		},
	]);
	expect(cmp.deltas.acceptanceAdvantage).toBe("tie");
	expect(cmp.deltas.acceptanceAdvantageVsNone).toBe("skillsmith");
	expect(cmp.deltas.strategyCounts).toEqual({
		reuse: 1,
		adapt: 0,
		compose: 1,
		provisional: 0,
	});
	expect(cmp.deltas.abstention).toEqual({
		needsInputRuns: 1,
		labeledAppropriate: 1,
		labeledExcessive: 0,
		unlabeled: 0,
	});
});
