import { z } from "zod";
import {
	evalConditionSchema,
	evalRunResultSchema,
	evalTaskSchema,
	type EvalComparison,
	type EvalRunResult,
	type EvalTask,
} from "./task.js";
import { compareConditionRuns, synthesisNotClearlyBetter } from "./compare.js";
import { assertEvalSuiteAudited } from "./audit.js";
export interface InferenceRecord {
	inputDigest: string;
	value: unknown;
	provider: string;
}

export const evalSuiteSchema = z.strictObject({
	id: z.string().min(1).max(160),
	tasks: z.array(evalTaskSchema).min(1).max(64),
	/** Per-task, per-condition recorded inference outputs for replay. */
	records: z
		.array(
			z.strictObject({
				taskId: z.string().min(1).max(160),
				condition: evalConditionSchema,
				records: z.array(
					z.strictObject({
						inputDigest: z.string().min(1),
						value: z.unknown(),
						provider: z.string().min(1),
					}),
				),
			}),
		)
		.default([]),
});
export type EvalSuite = z.infer<typeof evalSuiteSchema>;

export interface ConditionRunner {
	(
		task: EvalTask,
		condition: "none" | "agent_skills" | "skillsmith",
		records: InferenceRecord[],
	): Promise<EvalRunResult>;
}

/**
 * Quality-eval kit: runs the same tasks under A/B/C with recorded-inference records.
 * Default wiring query 「検証」 must not be treated as a quality score — this kit
 * only compares provided run results / fixtures.
 */
export async function runEvalSuite(
	suite: EvalSuite,
	runner: ConditionRunner,
	audit?: {
		expectedDigests?: Record<string, string>;
		requireRecords?: boolean;
	},
): Promise<{
	comparisons: EvalComparison[];
	synthesisNotClearlyBetter: boolean[];
}> {
	const parsed = evalSuiteSchema.parse(suite);
	if (audit) assertEvalSuiteAudited(parsed, audit);
	const comparisons: EvalComparison[] = [];
	const flags: boolean[] = [];
	for (const task of parsed.tasks) {
		const runs: EvalRunResult[] = [];
		for (const condition of ["none", "agent_skills", "skillsmith"] as const) {
			const pack = parsed.records.find(
				(r) => r.taskId === task.id && r.condition === condition,
			);
			const result = await runner(task, condition, pack?.records ?? []);
			runs.push(
				evalRunResultSchema.parse({ ...result, taskId: task.id, condition }),
			);
		}
		const cmp = compareConditionRuns(runs);
		comparisons.push(cmp);
		flags.push(synthesisNotClearlyBetter(cmp));
	}
	return { comparisons, synthesisNotClearlyBetter: flags };
}
