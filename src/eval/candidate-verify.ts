import { digest } from "../service/identity.js";

/**
 * Eval-only local candidate executor. Does not talk to Eumenes host APIs.
 * Callers supply the observed outcome; this only binds digests for audit.
 */
export function localCandidateVerificationFixture(input: {
	sections: { id: string; body: string }[];
	conditions: string[];
	evidence: string[];
	/** Observed local run of THIS candidate text — not the source build. */
	observedOutcome: "succeeded" | "failed";
	reportDigest: string;
	reportRevision: number;
}) {
	const proposalDigest = digest({
		sections: input.sections,
		conditions: input.conditions,
		evidence: input.evidence,
	});
	return {
		status: "bound" as const,
		proposalDigest,
		reportDigest: input.reportDigest,
		reportRevision: input.reportRevision,
		verifierVersion: "candidate_verify.v1" as const,
		outcome: input.observedOutcome,
		/** Explicit: source-build success alone is not candidate verification. */
		sourceBuildSuccessIsNotCandidateProof: true,
	};
}
