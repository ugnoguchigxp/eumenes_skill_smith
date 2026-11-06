import { z } from "zod";

/**
 * Auxiliary eval-kit metrics inspired by Ragas. Never replace task acceptance.
 * Heuristics are clearly labeled and run only in the eval kit.
 */
export const auxiliaryMetricsSchema = z.strictObject({
	/** Fraction of guidance body tokens that also appear in retrieved context (crude overlap). */
	faithfulnessOverlap: z.number().min(0).max(1),
	/** Fraction of expected context refs that appear in used refs. */
	contextRelevanceAtUsed: z.number().min(0).max(1).nullable(),
	method: z.literal("eval_kit_token_overlap_v1"),
});
export type AuxiliaryMetrics = z.infer<typeof auxiliaryMetricsSchema>;

function tokens(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((t) => t.length > 1),
	);
}

/** Deterministic eval-kit helper. Product meaning judgment must not call this. */
export function auxiliaryMetrics(input: {
	guidanceBody: string;
	contextBodies: string[];
	usedRefs: string[];
	expectedContextRefs?: string[];
}): AuxiliaryMetrics {
	const body = tokens(input.guidanceBody);
	const ctx = new Set<string>();
	for (const c of input.contextBodies) for (const t of tokens(c)) ctx.add(t);
	let overlap = 0;
	for (const t of body) if (ctx.has(t)) overlap++;
	const faithfulnessOverlap = body.size ? overlap / body.size : 0;
	const expected = input.expectedContextRefs;
	const contextRelevanceAtUsed =
		expected && expected.length
			? expected.filter((r) => input.usedRefs.includes(r)).length /
				expected.length
			: null;
	return auxiliaryMetricsSchema.parse({
		faithfulnessOverlap,
		contextRelevanceAtUsed,
		method: "eval_kit_token_overlap_v1",
	});
}
