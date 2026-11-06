import { z } from "zod";

/**
 * Structural comparison of one-shot vs two-round disclosure under identical total limits.
 * Does not invent quality/acceptance scores.
 */
export const disclosureRoundCompareSchema = z.strictObject({
	totalModelCalls: z.number().int().positive(),
	oneRound: z.strictObject({
		discloseCalls: z.literal(1),
		readyOrTerminalCalls: z.number().int().nonnegative(),
		disclosedBytes: z.number().int().nonnegative(),
		unusedDisclosedSectionIds: z.array(z.string()).default([]),
	}),
	twoRounds: z.strictObject({
		discloseCalls: z.literal(2),
		readyOrTerminalCalls: z.number().int().nonnegative(),
		disclosedBytes: z.number().int().nonnegative(),
		unusedDisclosedSectionIds: z.array(z.string()).default([]),
	}),
	deltas: z.strictObject({
		extraDiscloseBytes: z.number().int(),
		twoRoundsExhaustedBudget: z.boolean(),
		oneRoundExhaustedBudget: z.boolean(),
	}),
	method: z.literal("disclosure_round_compare_v1"),
});
export type DisclosureRoundCompare = z.infer<
	typeof disclosureRoundCompareSchema
>;

export function compareDisclosureRounds(input: {
	totalModelCalls: number;
	oneRound: {
		discloseCalls: 1;
		readyOrTerminalCalls: number;
		disclosedBytes: number;
		unusedDisclosedSectionIds?: string[];
	};
	twoRounds: {
		discloseCalls: 2;
		readyOrTerminalCalls: number;
		disclosedBytes: number;
		unusedDisclosedSectionIds?: string[];
	};
}): DisclosureRoundCompare {
	const oneUsed =
		input.oneRound.discloseCalls + input.oneRound.readyOrTerminalCalls;
	const twoUsed =
		input.twoRounds.discloseCalls + input.twoRounds.readyOrTerminalCalls;
	return disclosureRoundCompareSchema.parse({
		totalModelCalls: input.totalModelCalls,
		oneRound: {
			...input.oneRound,
			unusedDisclosedSectionIds: input.oneRound.unusedDisclosedSectionIds ?? [],
		},
		twoRounds: {
			...input.twoRounds,
			unusedDisclosedSectionIds:
				input.twoRounds.unusedDisclosedSectionIds ?? [],
		},
		deltas: {
			extraDiscloseBytes:
				input.twoRounds.disclosedBytes - input.oneRound.disclosedBytes,
			oneRoundExhaustedBudget: oneUsed >= input.totalModelCalls,
			twoRoundsExhaustedBudget: twoUsed >= input.totalModelCalls,
		},
		method: "disclosure_round_compare_v1",
	});
}
