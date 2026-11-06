import { z } from "zod";

/**
 * Auxiliary eval-kit metrics inspired by Ragas. Never replace task acceptance.
 * Heuristics are clearly labeled and run only in the eval kit.
 */
export const auxiliaryMetricsSchema = z.strictObject({
	/**
	 * Surface/token overlap only (字面一致). Not semantic faithfulness.
	 * Unsegmented Japanese may look high/low without meaning agreement.
	 */
	lexicalOverlap: z.number().min(0).max(1),
	/** Fraction of expected context refs that appear in used refs. */
	contextRelevanceAtUsed: z.number().min(0).max(1).nullable(),
	method: z.literal("eval_kit_lexical_overlap_v1"),
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
	const lexicalOverlap = body.size ? overlap / body.size : 0;
	const expected = input.expectedContextRefs;
	const contextRelevanceAtUsed =
		expected && expected.length
			? expected.filter((r) => input.usedRefs.includes(r)).length /
				expected.length
			: null;
	return auxiliaryMetricsSchema.parse({
		lexicalOverlap,
		contextRelevanceAtUsed,
		method: "eval_kit_lexical_overlap_v1",
	});
}
