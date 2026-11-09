import type {
	Authority,
	Decision,
	GuidanceRequest,
	Section,
	VersionRef,
	ResultInput,
	ReadyDecision,
	SourceSearch,
} from "./schema.js";
export type {
	Authority,
	Decision,
	GuidanceRequest,
	Section,
	VersionRef,
	ResultInput,
	ReadyDecision,
	SourceSearch,
};
export interface EvidenceCard {
	ref: string;
	version: VersionRef;
	title: string;
	status: "active" | "superseded" | "retracted";
	complete: boolean;
	external: boolean;
	/** Host labels these, not the source document. */
	scope: string;
	/** Successor ref from the same origin, for superseded items. */
	supersededBy?: string;
}
export interface Evidence extends EvidenceCard {
	body: string;
	sections?: Section[];
	retrievedAt?: number;
}
export interface Policy {
	version: VersionRef;
	body: string;
	alreadyPresent: boolean;
}
export interface Usage {
	modelCalls: number;
	sourceCalls: number;
	inputTokens: number | null;
	outputTokens: number | null;
	reasoningTokens: number | null;
	cachedInputTokens: number | null;
}
export interface Build {
	ref: string;
	requestRef: string;
	scope: string;
	key: string;
	digest: string;
	content: {
		contractVersion: "skillsmith.v1";
		task: GuidanceRequest["task"];
		audience: GuidanceRequest["audience"];
		environment: GuidanceRequest["environment"];
		body: string;
		decision: Extract<Decision, { kind: "ready" }>;
		dependencies: Omit<Evidence, "body" | "sections">[];
		policy: Policy;
	};
	createdAt: number;
	expiresAt: number;
	usage: Usage;
	revoked: boolean;
	publication?: {
		ref: string;
		digest: string;
		selectionDigest: string;
		selectorVersion?: string;
		receipt: string;
		assessment: string;
		composition?: {
			version: string;
			parts: { ref: string; digest: string }[];
			bundleDigest: string;
			reviewReceipt: string;
		};
	};
	generator?: { instructions: string; contractVersion: "skillsmith.v1" };
}
export type Outcome =
	| { kind: "ready"; buildRef: string }
	| { kind: "needs_input"; missing: string[] }
	| { kind: "unavailable" | "rejected"; code: string }
	| { kind: "cancelled" | "expired"; code: string };
export type Reply = (
	| { kind: "ready"; build: Build }
	| { kind: "pending"; deadlineAt: number; retryAfterMs: number }
	| Exclude<Outcome, { kind: "ready" }>
) & { contractVersion: "skillsmith.v1"; requestRef?: string };
export interface RequestRecord {
	ref: string;
	request: GuidanceRequest;
	authority: Authority;
	key: string;
	inputDigest: string;
	epoch: number;
	revision: number;
	createdAt: number;
	jobRef: string | null;
	waitingParent: string | null;
	runToken: string | null;
	outcome: Outcome | null;
	usage: Usage;
}
export interface Prepared {
	record: RequestRecord;
	runToken: string;
	policy: Policy;
}
export interface Executed {
	decision: Decision;
	evidence: Evidence[];
	receipt?: string;
	tokens?: {
		input: number | null;
		output: number | null;
		reasoningTokens?: number | null;
		cachedInputTokens?: number | null;
	};
}
export interface Delivery {
	id: string;
	requestRef: string;
	scope: string;
	epoch: number;
	acknowledged: boolean;
}
export interface Report {
	input: ResultInput;
	scope: string;
	revision: number;
	digest: string;
}
export interface Proposal {
	ref: string;
	scope: string;
	buildRef: string;
	executionRef: string;
	sections: Section[];
	conditions: string[];
	evidence: string[];
	status: "proposed" | "validated" | "accepted" | "rejected" | "withdrawn";
	revision: number;
	executionVerified?: boolean;
	candidateVerification?: {
		status: "unverified" | "bound" | "invalidated";
		proposalDigest: string;
		reportDigest: string;
		reportRevision: number;
		verifierVersion: "candidate_verify.v1";
		outcome?: "succeeded" | "failed";
	};
}
export interface Reflection {
	ref: string;
	scope: string;
	executionRef: string;
	reportDigest: string;
	buildRef: string;
	authority: Authority;
	reserved: boolean;
	outcome: "pending" | "completed" | "failed";
	proposalRef: string | null;
	revision: number;
	inputTokens: number | null;
	outputTokens: number | null;
}
export interface ImprovementGrounding {
	buildBody: string;
	sourceRefs: string[];
	dependencyVersions: import("./schema.js").VersionRef[];
	contrast: { succeeded: string[]; failed: string[] };
}
export interface PreparedReflection {
	reflection: Reflection;
	report: Report;
	grounding?: ImprovementGrounding;
}

export interface WorkflowTrajectoryStep {
	action: string;
	observation: string;
	outcome: "succeeded" | "failed" | "incomplete" | "cancelled";
}
export interface PreparedWorkflow {
	buildRef: string;
	executionRef: string;
	taskGoal: string;
	succeededSummaries: string[];
	/** Optional failed peer summaries for contrast experiments; quality 未測定. */
	failedSummaries: string[];
	/** Optional action/observation pairs; not hidden chain-of-thought. */
	trajectories: WorkflowTrajectoryStep[];
	evidence: string[];
	reportDigest: string | null;
	reportRevision: number | null;
	authority: Pick<Authority, "scope" | "principal" | "epoch">;
	inputDigest: string;
}
