import { z } from "zod";
import { buildSchema, versionRefSchema } from "./schema.js";
import type { Authority, GuidanceRequest, Reply, Usage } from "./types.js";
import type { SkillArtifact } from "../service/skill-markdown.js";

const id = z.string().min(1).max(160);
export const skillArtifactSchema = z.strictObject({
	name: z.string().min(1).max(64),
	path: z.string().min(1).max(160),
	content: z.string().min(1).max(32768),
	digest: id,
	rendererVersion: id,
	sourceExtractorVersion: id,
	bundleDigest: id,
	files: z
		.array(
			z.strictObject({
				path: z.string().min(1).max(160),
				content: z.string().max(32768),
				digest: id,
			}),
		)
		.max(8),
});
/** Internal publication record. Never expose the origin Build through catalog metadata. */
export const approvedSkillSchema = z.strictObject({
	ref: id,
	scope: id,
	digest: id,
	approvalRef: id,
	applicability: z.string().trim().min(1).max(2000),
	artifact: skillArtifactSchema,
	template: buildSchema,
	expiresAt: z.number().int().positive(),
});
export type ApprovedSkill = z.infer<typeof approvedSkillSchema>;
export interface ApprovedSkillScan {
	scope: string;
	/** Local metadata retrieval query; not a semantic applicability verdict. */
	query?: string;
	environment: GuidanceRequest["environment"];
	audience: GuidanceRequest["audience"];
	now: number;
	limit: number;
	cursor?: string;
}
export interface ApprovedSkillPage {
	records: ApprovedSkill[];
	/** Null means the structurally compatible range is exhausted. */
	nextCursor: string | null;
}
export interface ApprovedSkillStore<Tx> {
	get(tx: Tx, ref: string): ApprovedSkill | null;
	/** Structural filtering before paging. Final semantic applicability remains an LLM decision. */
	scan?(tx: Tx, query: ApprovedSkillScan): ApprovedSkillPage;
	list(tx: Tx, scope: string, limit: number): ApprovedSkill[];
	put(tx: Tx, record: ApprovedSkill): void;
	/** Host approval must bind the exact digest, publication scope and applicability statement. */
	authorizePublication(
		tx: Tx,
		authority: Authority,
		record: ApprovedSkill,
	): boolean;
	/** Owner domain verifies approval validity; a boolean supplied by a caller is not approval. */
	approvalCurrent(tx: Tx, record: ApprovedSkill): boolean;
}
export const skillSelectionSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("selected"),
		ref: id,
		assessment: z.string().min(1).max(1000),
	}),
	z.strictObject({
		kind: z.literal("miss"),
		reason: z.string().min(1).max(1000),
	}),
]);
export type SkillSelection = z.infer<typeof skillSelectionSchema>;
export interface PreparedSkillSelection {
	request: GuidanceRequest;
	authority: Authority;
	candidates: ApprovedSkill[];
	catalog: { scanned: number; exhausted: boolean };
	digest: string;
}
export interface SelectedSkill {
	preparedDigest: string;
	decision: SkillSelection;
	receipt: string | null;
	usage: Usage;
}
type DeliveryStatus<T> = T extends { contractVersion: string }
	? Omit<T, "contractVersion"> & { contractVersion: "skillsmith.delivery.v1" }
	: never;
export type SkillDelivery =
	| DeliveryStatus<Exclude<Reply, { kind: "ready" }>>
	| {
			contractVersion: "skillsmith.delivery.v1";
			kind: "ready";
			requestRef: string;
			auditRef: string;
			publicationRef?: string;
			skill: SkillArtifact;
			dependencyVersions: z.infer<typeof versionRefSchema>[];
	  };

/** Single-copy wire contract. Audit access is separately authorized. */
const deliveryEnvelope = {
	contractVersion: z.literal("skillsmith.delivery.v1"),
	requestRef: id.optional(),
};
export const skillDeliverySchema = z.discriminatedUnion("kind", [
	z.strictObject({
		...deliveryEnvelope,
		kind: z.literal("ready"),
		requestRef: id,
		auditRef: id,
		publicationRef: id.optional(),
		skill: skillArtifactSchema,
		dependencyVersions: z.array(versionRefSchema).max(8),
	}),
	z.strictObject({
		...deliveryEnvelope,
		kind: z.literal("pending"),
		deadlineAt: z.number().int().positive(),
		retryAfterMs: z.number().int().positive(),
	}),
	z.strictObject({
		...deliveryEnvelope,
		kind: z.literal("needs_input"),
		missing: z.array(z.string().min(1).max(8000)).min(1).max(16),
	}),
	...(["unavailable", "rejected", "expired", "cancelled"] as const).map(
		(kind) =>
			z.strictObject({ ...deliveryEnvelope, kind: z.literal(kind), code: id }),
	),
]);
