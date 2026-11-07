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

const isolationSuite = () => ({
	id: "isolated",
	tasks: [
		{
			id: "task",
			goal: "確認する",
			acceptance: [{ id: "a", text: "対応を確認する" }],
			constraints: [],
			expectedRefs: [],
		},
	],
	records: [],
});
for (const nested of [false, true]) {
	test(`eval kit rejects ${nested ? "nested" : "top-level"} task mutation before a later condition runs`, async () => {
		let calls = 0;
		await expect(
			runEvalSuite(isolationSuite(), async (task, condition) => {
				calls++;
				if (nested) task.acceptance[0]!.text = "changed";
				else task.goal = "changed";
				return {
					taskId: task.id,
					condition,
					kind: "ready",
					usedRefs: [],
					modelCalls: 0,
					sourceCalls: 0,
					inputTokens: null,
					outputTokens: null,
				};
			}),
		).rejects.toThrow("eval_task_mutated");
		expect(calls).toBe(1);
	});
}
for (const wrong of ["task", "condition"] as const) {
	test(`eval kit rejects a runner result with wrong ${wrong} identity`, async () => {
		await expect(
			runEvalSuite(isolationSuite(), async (task, condition) => ({
				taskId: wrong === "task" ? "other" : task.id,
				condition: wrong === "condition" ? "skillsmith" : condition,
				kind: "ready",
				usedRefs: [],
				modelCalls: 0,
				sourceCalls: 0,
				inputTokens: null,
				outputTokens: null,
			})),
		).rejects.toThrow("eval_run_identity_mismatch");
	});
}
test("eval kit rejects duplicate tasks and record packs before any runner call", async () => {
	const suite = isolationSuite();
	suite.tasks.push(structuredClone(suite.tasks[0]!));
	await expect(
		runEvalSuite(suite, async () => {
			throw Error("must not run");
		}),
	).rejects.toThrow("eval_duplicate_task");
	const withPacks = {
		...isolationSuite(),
		records: [
			{ taskId: "task", condition: "none" as const, records: [] },
			{ taskId: "task", condition: "none" as const, records: [] },
		],
	};
	await expect(
		runEvalSuite(withPacks, async () => {
			throw Error("must not run");
		}),
	).rejects.toThrow("eval_duplicate_condition");
});
