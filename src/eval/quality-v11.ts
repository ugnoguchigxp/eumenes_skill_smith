import { z } from "zod";
export const QUALITY_V11_VERSION = "quality-judge.v4.format100";
export const QUALITY_V11_INSTRUCTIONS = `厳格採点: 正確35/具体25/網羅20/簡潔10/形式10、整数和100。実世界のAPI/手順を判断し忠実なコピーや安全一般論だけで高得点にしない。誤具体例はincorrectExamplesに記し正確最大12/総合最大50。形式はASCII name、コード/API以外の日本語本文、目的/必須原則/情報・ツールの安全性/標準ワークフロー/完成条件、必要な場合だけモード、存在するリソースリンク、監査メタ非混入を見る。出典見出しが無いことは減点しない。各基準に個別理由を記す。referencesも検査するが未測定を実証と推測しない。gold/期待IDは不要。JSONのみ。`;
const reason = z.string().trim().min(1).max(1200);
export const qualityV11Schema = z
	.strictObject({
		score: z.number().int().min(0).max(100),
		correctness: z.number().int().min(0).max(35),
		actionability: z.number().int().min(0).max(25),
		coverage: z.number().int().min(0).max(20),
		concision: z.number().int().min(0).max(10),
		format: z.number().int().min(0).max(10),
		reasons: z.strictObject({
			correctness: reason,
			actionability: reason,
			coverage: reason,
			concision: reason,
			format: reason,
		}),
		incorrectExamples: z.array(reason).max(16),
	})
	.refine(
		(r) =>
			r.score ===
			r.correctness + r.actionability + r.coverage + r.concision + r.format,
		"score_sum_mismatch",
	)
	.refine(
		(r) =>
			!r.incorrectExamples.length || (r.correctness <= 12 && r.score <= 50),
		"incorrect_example_cap",
	);
