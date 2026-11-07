import { z } from "zod";

/**
 * Eval-only usage provenance ledger. Does not invent missing provider numbers.
 * Product request.usage remains the committed aggregate; this records per-call traces.
 */
export const usageCallSchema = z.strictObject({
	callKind: z.enum([
		"build",
		"reflection",
		"workflow",
		"delivery_validate",
		"reformulation",
	]),
	inputDigest: z.string().min(1).optional(),
	receipt: z.string().min(1).optional(),
	inputTokens: z.number().int().nonnegative().nullable(),
	outputTokens: z.number().int().nonnegative().nullable(),
	reasoningTokens: z.number().int().nonnegative().nullable().default(null),
	cachedInputTokens: z.number().int().nonnegative().nullable().default(null),
	/** True when provider says reasoning is already counted inside outputTokens. */
	reasoningIncludedInOutput: z.boolean().default(false),
	outcome: z.enum(["ok", "invalid_output", "error", "cancelled"]),
});
export type UsageCall = z.infer<typeof usageCallSchema>;

export const usageLedgerSchema = z.strictObject({
	calls: z.array(usageCallSchema).max(256),
	totals: z.strictObject({
		inputTokens: z.number().int().nonnegative().nullable(),
		outputTokens: z.number().int().nonnegative().nullable(),
		reasoningTokens: z.number().int().nonnegative().nullable(),
		cachedInputTokens: z.number().int().nonnegative().nullable(),
		/** outputTokens plus separate reasoning when not already included. */
		billableOutputTokens: z.number().int().nonnegative().nullable(),
	}),
});
export type UsageLedger = z.infer<typeof usageLedgerSchema>;

function sumNullable(values: (number | null)[]): number | null {
	let total = 0;
	for (const v of values) {
		if (v === null) return null;
		total += v;
	}
	return total;
}

/** Aggregate calls without double-counting reasoning already inside output. */
export function aggregateUsageLedger(
	calls: z.input<typeof usageCallSchema>[],
): UsageLedger {
	const parsed = calls.map((c) => usageCallSchema.parse(c));
	const inputTokens = sumNullable(parsed.map((c) => c.inputTokens));
	const outputTokens = sumNullable(parsed.map((c) => c.outputTokens));
	const reasoningTokens = sumNullable(parsed.map((c) => c.reasoningTokens));
	const cachedInputTokens = sumNullable(parsed.map((c) => c.cachedInputTokens));
	let billableOutputTokens: number | null = outputTokens;
	if (billableOutputTokens !== null && reasoningTokens !== null) {
		const extra = parsed.reduce((n, c) => {
			if (c.reasoningIncludedInOutput) return n;
			if (c.reasoningTokens === null) return n;
			return n + c.reasoningTokens;
		}, 0);
		// If any call had null reasoning while claiming separate, billable becomes null.
		if (
			parsed.some(
				(c) => !c.reasoningIncludedInOutput && c.reasoningTokens === null,
			)
		)
			billableOutputTokens = null;
		else billableOutputTokens += extra;
	} else if (
		reasoningTokens === null &&
		parsed.some((c) => !c.reasoningIncludedInOutput)
	) {
		// Unknown separate reasoning — do not invent billable total beyond output.
		billableOutputTokens = outputTokens;
	}
	return usageLedgerSchema.parse({
		calls: parsed,
		totals: {
			inputTokens,
			outputTokens,
			reasoningTokens,
			cachedInputTokens,
			billableOutputTokens,
		},
	});
}
