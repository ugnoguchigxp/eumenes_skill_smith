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
		observedBillableOutputTokens: z.number().int().nonnegative(),
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
	const observedBillableOutputTokens = parsed.reduce(
		(sum, c) =>
			sum +
			(c.outputTokens ?? 0) +
			(c.reasoningIncludedInOutput ? 0 : (c.reasoningTokens ?? 0)),
		0,
	);
	const billableOutputTokens = parsed.some(
		(c) =>
			c.outputTokens === null ||
			(!c.reasoningIncludedInOutput && c.reasoningTokens === null),
	)
		? null
		: observedBillableOutputTokens;

	return usageLedgerSchema.parse({
		calls: parsed,
		totals: {
			inputTokens,
			outputTokens,
			reasoningTokens,
			cachedInputTokens,
			billableOutputTokens,
			observedBillableOutputTokens,
		},
	});
}
