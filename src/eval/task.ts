import { z } from "zod";

const id = z.string().min(1).max(160);
const text = z.string().trim().min(1).max(8000);

/** One fixed evaluation task. Real-world corpuses are supplied by the user; this schema alone does not invent them. */
export const evalTaskSchema = z.strictObject({
	id,
	goal: text,
	acceptance: z.array(z.strictObject({ id, text })).min(1).max(32),
	constraints: z.array(z.strictObject({ id, text })).max(32).default([]),
	/** Refs that a correct retrieval should surface (proposal 03). */
	expectedRefs: z.array(id).max(32).default([]),
	/** Optional human/judge labels for later calibration; absent means unlabeled. */
	labels: z
		.strictObject({
			acceptanceMet: z.boolean().optional(),
			misApplied: z.boolean().optional(),
			needsInputAppropriate: z.boolean().optional(),
		})
		.optional(),
});
export type EvalTask = z.infer<typeof evalTaskSchema>;

export const evalConditionSchema = z.enum([
	"none",
	"agent_skills",
	"skillsmith",
]);
export type EvalCondition = z.infer<typeof evalConditionSchema>;

/** One run under one condition. Metrics are recorded; this module does not decide a winner. */
export const evalRunResultSchema = z.strictObject({
	taskId: id,
	condition: evalConditionSchema,
	kind: z.enum(["ready", "needs_input", "unavailable", "rejected", "error"]),
	/** Source refs the condition used or disclosed. */
	usedRefs: z.array(id).max(32).default([]),
	missing: z.array(text).max(16).optional(),
	code: id.optional(),
	body: z.string().max(32768).optional(),
	inputTokens: z.number().int().nonnegative().nullable().default(null),
	outputTokens: z.number().int().nonnegative().nullable().default(null),
	modelCalls: z.number().int().nonnegative().default(0),
	sourceCalls: z.number().int().nonnegative().default(0),
	/** Observed product strategy when kind=ready; absent otherwise. */
	actualStrategy: z
		.enum(["reuse", "adapt", "compose", "provisional"])
		.optional(),
	/** Human/judge abstention labels; never inferred from kind alone. */
	abstention: z
		.strictObject({
			appropriate: z.boolean().optional(),
			excessive: z.boolean().optional(),
			source: z.enum(["human", "judge", "fixture"]).optional(),
		})
		.optional(),
	/** Human or calibrated-judge labels applied after the run. */
	judgment: z
		.strictObject({
			acceptanceMet: z.boolean().optional(),
			misApplied: z.boolean().optional(),
			needsInputAppropriate: z.boolean().optional(),
			source: z.enum(["human", "judge", "fixture"]).optional(),
		})
		.optional(),
});
export type EvalRunResult = z.infer<typeof evalRunResultSchema>;

export const evalComparisonSchema = z.strictObject({
	taskId: id,
	runs: z.array(evalRunResultSchema).min(1).max(3),
	/** Structural comparison only; never a hardcoded winner. */
	deltas: z.strictObject({
		acceptanceAdvantage: z
			.enum(["none", "agent_skills", "skillsmith", "tie", "incomplete"])
			.optional(),
		/** Paired display vs none (A); incomplete when unlabeled. */
		acceptanceAdvantageVsNone: z
			.enum(["none", "agent_skills", "skillsmith", "tie", "incomplete"])
			.optional(),
		misApplicationWorse: z
			.enum(["none", "agent_skills", "skillsmith", "tie", "incomplete"])
			.optional(),
		tokenDeltaSkillsmithVsBaseline: z.number().nullable().optional(),
		strategyCounts: z
			.strictObject({
				reuse: z.number().int().nonnegative().default(0),
				adapt: z.number().int().nonnegative().default(0),
				compose: z.number().int().nonnegative().default(0),
				provisional: z.number().int().nonnegative().default(0),
			})
			.optional(),
		abstention: z
			.strictObject({
				needsInputRuns: z.number().int().nonnegative(),
				labeledAppropriate: z.number().int().nonnegative(),
				labeledExcessive: z.number().int().nonnegative(),
				unlabeled: z.number().int().nonnegative(),
			})
			.optional(),
	}),
});
export type EvalComparison = z.infer<typeof evalComparisonSchema>;
