import { expect, test } from "bun:test";
import {
	induceWorkflowCandidate,
	runEvalSuite,
	type EvalRunResult,
} from "../eval/index.js";

test("runEvalSuite compares conditions without declaring a hardcoded winner", async () => {
	const { comparisons, synthesisNotClearlyBetter } = await runEvalSuite(
		{
			id: "suite:fixture",
			tasks: [
				{
					id: "task:1",
					goal: "確認する",
					acceptance: [{ id: "a", text: "説明がある" }],
					constraints: [],
					expectedRefs: [],
				},
			],
			records: [],
		},
		async (task, condition) =>
			({
				taskId: task.id,
				condition,
				kind: "ready",
				usedRefs: condition === "none" ? [] : ["skill:a"],
				inputTokens: 10,
				outputTokens: 5,
				modelCalls: 1,
				sourceCalls: 0,
				judgment:
					condition === "skillsmith"
						? { acceptanceMet: true, misApplied: false, source: "fixture" }
						: { acceptanceMet: false, misApplied: false, source: "fixture" },
			}) satisfies EvalRunResult,
	);
	expect(comparisons).toHaveLength(1);
	expect(comparisons[0]!.deltas.acceptanceAdvantage).toBe("skillsmith");
	expect(synthesisNotClearlyBetter[0]).toBe(false);
});

test("workflow induction uses InferencePort and stays a candidate shape", async () => {
	const candidate = await induceWorkflowCandidate(
		{
			inference: {
				complete: async () => ({
					value: {
						sections: [{ id: "start", body: "共通の確認をする。" }],
						conditions: ["成功報告が複数ある"],
						evidence: ["e1"],
					},
					inputTokens: 1,
					outputTokens: 1,
					receipt: "r",
				}),
			},
			now: () => 1,
		},
		{
			taskGoal: "資料を確認する",
			succeededSummaries: ["できた", "またできた"],
			evidence: ["e1"],
			requestRef: "wf:1",
		},
		new AbortController().signal,
	);
	expect(candidate.sections[0]!.id).toBe("start");
	expect(candidate.conditions[0]).toContain("成功");
});
