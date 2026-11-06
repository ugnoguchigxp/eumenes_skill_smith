import { z } from "zod";

export const CONTRACT = "skillsmith.v1" as const;
export { INSTRUCTION_VERSION } from "../instructions/build.js";
const id = z.string().min(1).max(160);
const text = z.string().trim().min(1).max(8000);
const unique = <T>(xs: T[]) => new Set(xs).size === xs.length;
export const versionRefSchema = z.strictObject({
	id,
	version: id,
	digest: id,
	generation: z.number().int().nonnegative(),
});
export const sectionSchema = z.strictObject({ id, body: text });
const clause = z.strictObject({ id, text });
export const requestSchema = z
	.strictObject({
		contractVersion: z.literal(CONTRACT),
		requestId: id,
		task: z.strictObject({
			goal: text,
			acceptance: z.array(clause).min(1).max(32),
			constraints: z.array(clause).max(32),
			references: z.array(id).max(32),
		}),
		audience: z.enum(["conversation", "worker", "pursuit", "external"]),
		environment: z.strictObject({
			id,
			capabilities: z.array(versionRefSchema).max(128),
			policy: versionRefSchema,
		}),
		limits: z.strictObject({
			deadlineAt: z.number().int().positive(),
			modelCalls: z.number().int().min(1).max(4),
			sourceCalls: z.number().int().min(1).max(32),
			candidates: z.number().int().min(1).max(20),
			documents: z.number().int().min(1).max(8),
			outputBytes: z.number().int().min(256).max(32768),
			inputBytes: z.number().int().min(1024).max(131072),
			outputTokens: z.number().int().min(1).max(8192),
		}),
		prior: z
			.strictObject({ requestRef: id.optional(), buildRef: id.optional() })
			.optional(),
	})
	.superRefine((r, ctx) => {
		for (const items of [
			r.task.acceptance,
			r.task.constraints,
			r.environment.capabilities,
		]) {
			if (!unique(items.map((x) => x.id)))
				ctx.addIssue({ code: "custom", message: "duplicate_ids" });
		}
	});
export type GuidanceRequest = z.infer<typeof requestSchema>;
export type VersionRef = z.infer<typeof versionRefSchema>;
export type Section = z.infer<typeof sectionSchema>;

export const authoritySchema = z.strictObject({
	scope: id,
	principal: id,
	epoch: z.number().int().nonnegative(),
	sourceRefs: z.array(id).max(64),
	parentRef: id.optional(),
	searchTask: z.string().trim().min(1).max(512).optional(),
	permissions: z.array(z.enum(["build", "report", "manage"])).max(3),
});
export type Authority = z.infer<typeof authoritySchema>;
const ready = z.strictObject({
	kind: z.literal("ready"),
	strategy: z.enum(["reuse", "adapt", "compose", "provisional"]),
	sourceRefs: z.array(id).max(8).refine(unique),
	sections: z.array(sectionSchema).max(16),
	patches: z
		.array(z.strictObject({ sourceRef: id, sectionId: id, body: text }))
		.max(16),
	requiredCapabilities: z.array(id).max(128).refine(unique),
	verification: z.array(text).min(1).max(16),
	assumptions: z
		.array(
			z.strictObject({
				text,
				mandatory: z.boolean(),
				resolved: z.boolean(),
			}),
		)
		.max(16),
});
export const decisionSchema = z.discriminatedUnion("kind", [
	ready,
	z.strictObject({
		kind: z.literal("needs_input"),
		missing: z.array(text).min(1).max(16),
	}),
	z.strictObject({ kind: z.literal("unavailable"), code: id }),
]);
export type Decision = z.infer<typeof decisionSchema>;
export type ReadyDecision = Extract<Decision, { kind: "ready" }>;
/** Model turns during build: terminal decisions plus budgeted control actions. */
export const modelTurnSchema = z.discriminatedUnion("kind", [
	ready,
	z.strictObject({
		kind: z.literal("needs_input"),
		missing: z.array(text).min(1).max(16),
	}),
	z.strictObject({ kind: z.literal("unavailable"), code: id }),
	z.strictObject({
		kind: z.literal("re_search"),
		query: z.string().trim().min(1).max(512),
	}),
	z.strictObject({
		kind: z.literal("disclose"),
		items: z
			.array(
				z.strictObject({
					ref: id,
					sectionIds: z.array(id).max(64).optional(),
				}),
			)
			.min(1)
			.max(8),
	}),
]);
export type ModelTurn = z.infer<typeof modelTurnSchema>;
export const resultSchema = z.strictObject({
	reportId: id,
	buildRef: id,
	executionRef: id,
	outcome: z.enum([
		"succeeded",
		"failed",
		"cancelled",
		"incomplete",
		"explained",
	]),
	evidence: z.array(id).max(32),
	summary: text,
	improvement: text.optional(),
	expectedRevision: z.number().int().nonnegative(),
});
export type ResultInput = z.infer<typeof resultSchema>;

export const policySchema = z.strictObject({
	version: versionRefSchema,
	body: z.string().max(32768),
	alreadyPresent: z.boolean(),
});
export const evidenceCardSchema = z.strictObject({
	ref: id,
	version: versionRefSchema,
	title: z.string().min(1).max(500),
	status: z.enum(["active", "superseded", "retracted"]),
	complete: z.boolean(),
	external: z.boolean(),
	scope: id,
	/** Successor reference reported by the same origin; only meaningful when superseded. */
	supersededBy: id.optional(),
});
/** Full evidence document returned by registry.read / source.get. Validated at the build boundary. */
export const evidenceSchema = evidenceCardSchema
	.extend({
		body: z.string().min(1).max(32768),
		sections: z.array(sectionSchema).max(64).optional(),
		/** Host-stamped retrieval time (ms since epoch). Optional; set by SkillSmith on read. */
		retrievedAt: z.number().int().nonnegative().optional(),
	})
	.superRefine((e, ctx) => {
		if (e.sections && !unique(e.sections.map((s) => s.id)))
			ctx.addIssue({ code: "custom", message: "duplicate_sections" });
	});
export const usageSchema = z.strictObject({
	modelCalls: z.number().int().nonnegative(),
	sourceCalls: z.number().int().nonnegative(),
	inputTokens: z.number().int().nonnegative().nullable(),
	outputTokens: z.number().int().nonnegative().nullable(),
	/** Provider reasoning tokens when separately reported; null if unknown. Never invent. */
	reasoningTokens: z.number().int().nonnegative().nullable().default(null),
	/** Provider cached-input tokens when separately reported; null if unknown. */
	cachedInputTokens: z.number().int().nonnegative().nullable().default(null),
});
export const buildSchema = z.strictObject({
	ref: id,
	requestRef: id,
	scope: id,
	key: id,
	digest: id,
	content: z.strictObject({
		contractVersion: z.literal(CONTRACT),
		task: requestSchema.shape.task,
		audience: requestSchema.shape.audience,
		environment: requestSchema.shape.environment,
		body: z.string().min(1).max(32768),
		decision: ready,
		dependencies: z.array(evidenceCardSchema).max(8),
		policy: policySchema,
	}),
	createdAt: z.number().int().nonnegative(),
	expiresAt: z.number().int().positive(),
	usage: usageSchema,
	revoked: z.boolean(),
});
const envelope = {
	contractVersion: z.literal(CONTRACT),
	requestRef: id.optional(),
};
export const replySchema = z.discriminatedUnion("kind", [
	z.strictObject({ ...envelope, kind: z.literal("ready"), build: buildSchema }),
	z.strictObject({
		...envelope,
		kind: z.literal("pending"),
		deadlineAt: z.number().int().positive(),
		retryAfterMs: z.number().int().positive(),
	}),
	z.strictObject({
		...envelope,
		kind: z.literal("needs_input"),
		missing: z.array(text).min(1).max(16),
	}),
	z.strictObject({ ...envelope, kind: z.literal("unavailable"), code: id }),
	z.strictObject({ ...envelope, kind: z.literal("rejected"), code: id }),
	z.strictObject({ ...envelope, kind: z.literal("cancelled"), code: id }),
	z.strictObject({ ...envelope, kind: z.literal("expired"), code: id }),
]);

const notice = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9_.:-]+$/);
/** Search-wide notices reported by an external source. Untrusted; passed to inference as data. */
export const sourceSearchSchema = z.strictObject({
	cards: z.array(evidenceCardSchema).max(100),
	warnings: z
		.array(
			z.strictObject({
				kind: notice,
				refs: z.array(z.string().min(1).max(512)).min(1).max(16),
			}),
		)
		.max(64),
	degraded: z.array(notice).max(32),
	truncated: z.boolean(),
});
export type SourceSearch = z.infer<typeof sourceSearchSchema>;

export const outcomeSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("ready"), buildRef: id }),
	z.strictObject({
		kind: z.literal("needs_input"),
		missing: z.array(text).min(1).max(16),
	}),
	z.strictObject({ kind: z.literal("unavailable"), code: id }),
	z.strictObject({ kind: z.literal("rejected"), code: id }),
	z.strictObject({ kind: z.literal("cancelled"), code: id }),
	z.strictObject({ kind: z.literal("expired"), code: id }),
]);
export const requestRecordSchema = z.strictObject({
	ref: id,
	request: requestSchema,
	authority: authoritySchema,
	key: id,
	inputDigest: id,
	epoch: z.number().int().nonnegative(),
	revision: z.number().int().nonnegative(),
	createdAt: z.number().int().nonnegative(),
	jobRef: id.nullable(),
	waitingParent: id.nullable(),
	runToken: id.nullable(),
	outcome: outcomeSchema.nullable(),
	usage: usageSchema,
});
export const reportRecordSchema = z.strictObject({
	input: resultSchema,
	scope: id,
	revision: z.number().int().nonnegative(),
	digest: id,
});
export const reflectionSchema = z.strictObject({
	ref: id,
	scope: id,
	executionRef: id,
	reportDigest: id,
	buildRef: id,
	authority: authoritySchema,
	reserved: z.boolean(),
	outcome: z.enum(["pending", "completed", "failed"]),
	proposalRef: id.nullable(),
	revision: z.number().int().nonnegative(),
	inputTokens: z.number().int().nonnegative().nullable(),
	outputTokens: z.number().int().nonnegative().nullable(),
});
export const proposalSchema = z.strictObject({
	ref: id,
	scope: id,
	buildRef: id,
	executionRef: id,
	sections: z.array(sectionSchema).max(16),
	conditions: z.array(text).max(32),
	evidence: z.array(id).max(32),
	status: z.enum([
		"proposed",
		"validated",
		"accepted",
		"rejected",
		"withdrawn",
	]),
	revision: z.number().int().nonnegative(),
	/** Set when a succeeded report+use binding verified the proposal locally. Not auto-publish. */
	executionVerified: z.boolean().optional(),
});
