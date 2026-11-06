import { z } from "zod";

export const defaultServiceLimits = {
	maxSubmitHorizonMs: 120_000,
	buildTtlMs: 30 * 86_400_000,
	pendingRetryAfterMs: 1_000,
	deliveryValidateTimeoutMs: 5_000,
	reflectionDeadlineMs: 30_000,
	reflectionMaxOutputTokens: 1_200,
	reflectionMaxDataBytes: 32_768,
} as const;

export type ServiceLimits = {
	-readonly [K in keyof typeof defaultServiceLimits]: number;
};

export const serviceLimitsSchema = z.strictObject({
	maxSubmitHorizonMs: z.number().int().positive().max(86_400_000),
	buildTtlMs: z
		.number()
		.int()
		.positive()
		.max(366 * 86_400_000),
	pendingRetryAfterMs: z.number().int().positive().max(600_000),
	deliveryValidateTimeoutMs: z.number().int().positive().max(120_000),
	reflectionDeadlineMs: z.number().int().positive().max(600_000),
	reflectionMaxOutputTokens: z.number().int().positive().max(8192),
	reflectionMaxDataBytes: z.number().int().positive().max(131_072),
});

export function resolveServiceLimits(
	partial?: Partial<ServiceLimits>,
): ServiceLimits {
	return serviceLimitsSchema.parse({
		...defaultServiceLimits,
		...partial,
	});
}
