import { z } from "zod";

const id = z.string().min(1).max(160);

/** LLM judge output for whether the assembled skill matches the expected skill. */
export const assemblyJudgeSchema = z.strictObject({
	score: z.number().int().min(0).max(10),
	expectedSkillUsed: z.boolean(),
	rationale: z.string().trim().min(1).max(2000),
});
export type AssemblyJudge = z.infer<typeof assemblyJudgeSchema>;

export const assemblyScoreSchema = z.strictObject({
	taskId: id,
	score: z.number().int().min(0).max(10),
	expectedSkillUsed: z.boolean(),
	/** 1-based rank among retrieved cards; null if the expected ref was not retrieved. */
	retrievalRank: z.number().int().positive().nullable(),
	usedRefs: z.array(id).max(32),
	expectedRefs: z.array(id).max(32),
	strategy: z.enum(["reuse", "adapt", "compose", "provisional"]).nullable(),
	kind: z.enum(["ready", "needs_input", "unavailable", "rejected", "error"]),
	rationale: z.string().trim().min(1).max(2000),
	judge: z.literal("llm"),
});
export type AssemblyScore = z.infer<typeof assemblyScoreSchema>;

export const scenarioTaskSchema = z.strictObject({
	id,
	goal: z.string().trim().min(1).max(8000),
	acceptance: z
		.array(z.strictObject({ id, text: z.string().trim().min(1).max(8000) }))
		.min(1)
		.max(32),
	expectedRefs: z.array(id).min(1).max(8),
	expectedTitle: z.string().trim().min(1).max(512),
});
export type ScenarioTask = z.infer<typeof scenarioTaskSchema>;

export const scenarioSuiteSchema = z.strictObject({
	id,
	tasks: z.array(scenarioTaskSchema).min(1).max(32),
});
export type ScenarioSuite = z.infer<typeof scenarioSuiteSchema>;

export function retrievalRank(
	cards: { ref: string }[],
	expectedRefs: string[],
): number | null {
	const wanted = new Set(expectedRefs);
	const index = cards.findIndex((card) => wanted.has(card.ref));
	return index < 0 ? null : index + 1;
}

export const JUDGE_INSTRUCTIONS = `タスクの目的と受入条件、検索で届いた候補、組み立てられた指針を見て、期待 Skill が正しく使われているかを 0 から 10 で評点する。
10 は期待 Skill を選び、その内容に沿った実行可能な指針になっている。
0 は期待 Skill が届いておらず、指針も別の内容か欠落している。
検索結果に期待 Skill が無いのに used と偽らない。届いていても選んでいなければ高得点にしない。
rationale は日本語で、選んだ根拠と不足を具体的に書く。出力は schema に合う JSON だけ。`;

export const judgeOutputSchema = {
	type: "object",
	additionalProperties: false,
	required: ["score", "expectedSkillUsed", "rationale"],
	properties: {
		score: { type: "integer", minimum: 0, maximum: 10 },
		expectedSkillUsed: { type: "boolean" },
		rationale: { type: "string", minLength: 1, maxLength: 2000 },
	},
} as const;

export function judgeData(input: {
	task: ScenarioTask;
	retrievalRank: number | null;
	retrieved: { ref: string; title: string }[];
	usedRefs: string[];
	strategy: AssemblyScore["strategy"];
	kind: AssemblyScore["kind"];
	sections: { id: string; body: string }[];
	body?: string | null;
	missing?: string[];
}) {
	return {
		task: {
			id: input.task.id,
			goal: input.task.goal,
			acceptance: input.task.acceptance,
			expectedRefs: input.task.expectedRefs,
			expectedTitle: input.task.expectedTitle,
		},
		retrievalRank: input.retrievalRank,
		retrieved: input.retrieved,
		assembled: {
			kind: input.kind,
			strategy: input.strategy,
			usedRefs: input.usedRefs,
			sections: input.sections,
			body: input.body ?? null,
			missing: input.missing ?? [],
		},
	};
}

export function scoreFromJudge(
	task: ScenarioTask,
	facts: {
		retrievalRank: number | null;
		usedRefs: string[];
		strategy: AssemblyScore["strategy"];
		kind: AssemblyScore["kind"];
	},
	judge: AssemblyJudge,
): AssemblyScore {
	return assemblyScoreSchema.parse({
		taskId: task.id,
		score: judge.score,
		expectedSkillUsed: judge.expectedSkillUsed,
		retrievalRank: facts.retrievalRank,
		usedRefs: facts.usedRefs,
		expectedRefs: task.expectedRefs,
		strategy: facts.strategy,
		kind: facts.kind,
		rationale: judge.rationale,
		judge: "llm",
	});
}
