import { z } from "zod";
export const QUALITY_100_VERSION = "quality-judge.v3.100";
export const QUALITY_100_INSTRUCTIONS = `厳格100点採点。正確さ40/具体性25/網羅20/簡潔さ15の整数で独立採点しscoreは和。実世界のAPI/コマンドと対象範囲を点検し、誤った具体例はincorrectExamplesへ具体的に記す。その場合正確さ最大15、総合最大50。出典への忠実さや安全一般論だけで高評価しない。定型文、評価メタ、同じ判断の反復、不要な節を簡潔さから減点する。必須の停止・安全性を失う省略は正確さ/網羅から減点。本文と全referencesを読み、実行結果の未測定を捏造しない。gold・期待IDは不要。schemaに合うJSONのみ。`;
export const quality100Schema = z
	.strictObject({
		score: z.number().int().min(0).max(100),
		correctness: z.number().int().min(0).max(40),
		actionability: z.number().int().min(0).max(25),
		coverage: z.number().int().min(0).max(20),
		concision: z.number().int().min(0).max(15),
		incorrectExamples: z.array(z.string().trim().min(1).max(1000)).max(16),
		rationale: z.string().trim().min(1).max(2500),
	})
	.refine(
		(r) =>
			r.score === r.correctness + r.actionability + r.coverage + r.concision,
		"score_sum_mismatch",
	)
	.refine(
		(r) =>
			!r.incorrectExamples.length || (r.correctness <= 15 && r.score <= 50),
		"incorrect_example_cap",
	);
