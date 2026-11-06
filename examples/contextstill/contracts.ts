import { z } from "zod";

export const FORMAT = "skillsmith-contextstill-fixture.v1";
export const MAX_BYTES = 32 * 1024;
export const TRUST = {
	trustClass: "untrusted_knowledge_evidence",
	instructionAuthority: "none",
} as const;
export const handleSchema = z.string().regex(/^(kn|ep)_[a-z2-7]{26}$/);
const unique = <T>(items: T[]) => new Set(items).size === items.length;
export const searchArgs = z.strictObject({
	query: z.string().min(1).max(512),
	kinds: z
		.array(z.enum(["knowledge", "episode"]))
		.min(1)
		.max(2)
		.refine(unique)
		.default(["knowledge"]),
	types: z
		.array(z.enum(["rule", "procedure"]))
		.max(2)
		.refine(unique)
		.optional(),
	spaces: z
		.array(z.enum(["coding", "general", "eumenes"]))
		.min(1)
		.max(3)
		.refine(unique)
		.default(["coding", "general", "eumenes"]),
	theme: z.string().max(128).optional(),
	limit: z.number().int().min(1).max(20).default(8),
	depth: z.number().int().min(0).max(2).default(0),
});
export const getArgs = z.strictObject({ handle: handleSchema });
const common = {
	handle: handleSchema,
	title: z.string(),
	situation: z.string(),
	confidence: z.number(),
	importance: z.number(),
	status: z.enum(["candidate", "active", "superseded", "stale"]),
	space: z.enum(["coding", "general", "eumenes"]),
	createdAt: z.string(),
	updatedAt: z.string(),
	evidence: z.array(
		z.strictObject({ role: z.string(), sourceKind: z.string() }),
	),
	evidenceTruncated: z.boolean(),
};
export const itemSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		...common,
		kind: z.literal("knowledge"),
		layer: z.enum(["atom", "canonical"]),
		type: z.enum(["rule", "procedure"]),
		polarity: z.enum(["positive", "negative"]),
		body: z.string(),
		rationale: z.string(),
		exceptions: z.array(z.string()),
		examples: z.array(
			z.strictObject({
				situation: z.string(),
				action: z.string(),
				outcome: z.string(),
				episodes: z.array(handleSchema),
			}),
		),
		appliesWhen: z.array(z.string()),
		notAppliesWhen: z.array(z.string()),
		steps: z.array(z.string()),
		supportCount: z.number().int().nonnegative(),
		supersededBy: handleSchema.nullable(),
	}),
	z.strictObject({
		...common,
		kind: z.literal("episode"),
		intent: z.string(),
		decision: z.string(),
		observations: z.string(),
		action: z.string(),
		outcome: z.string(),
		lesson: z.string(),
		openQuestions: z.array(z.string()),
		outcomeKind: z.enum(["success", "failure", "mixed", "unknown"]),
		eventStart: z.string().nullable(),
		eventEnd: z.string().nullable(),
		timePrecision: z.enum(["exact", "minute", "day", "month", "unknown"]),
	}),
]);
export type PublicItem = z.infer<typeof itemSchema>;
export const fixtureStamp = z.strictObject({
	format: z.literal(FORMAT),
	revision: z.number().int().nonnegative(),
	digest: z.string().regex(/^[a-f0-9]{64}$/),
	complete: z.boolean(),
});
const trustSchema = z.strictObject({
	trustClass: z.literal(TRUST.trustClass),
	instructionAuthority: z.literal("none"),
});
export const documentSchema = z.strictObject({
	contractVersion: z.literal("contextstill-knowledge.v1"),
	trust: trustSchema,
	item: itemSchema,
	_fixture: fixtureStamp,
});
export const cardSchema = z.object({
	handle: handleSchema,
	kind: z.enum(["knowledge", "episode"]),
	title: z.string(),
	status: common.status,
	_fixture: fixtureStamp,
});
export const searchSchema = z.object({
	contractVersion: z.literal("contextstill-search.v1"),
	trust: trustSchema,
	results: z.array(cardSchema),
	warnings: z.array(z.unknown()),
	degraded: z.array(z.string()),
	truncated: z.boolean(),
});
export type SearchArgs = z.infer<typeof searchArgs>;
export const toolEnvelope = (
	id: string | number | null,
	payload: unknown,
	isError = false,
) => ({
	jsonrpc: "2.0",
	id,
	result: {
		content: [{ type: "text", text: JSON.stringify(payload) }],
		...(isError ? { isError: true } : {}),
	},
});
export const byteLength = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).byteLength;
