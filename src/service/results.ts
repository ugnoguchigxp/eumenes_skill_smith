import { z } from "zod";
import { resultSchema, sectionSchema } from "../contracts/schema.js";
import type {
	Authority,
	PreparedReflection,
	PreparedWorkflow,
	Proposal,
	Report,
} from "../contracts/types.js";
import type { Ports } from "../contracts/ports.js";
import type { ServiceLimits } from "../contracts/limits.js";
import {
	improvementInstructions,
	workflowInstructions,
} from "../instructions/build.js";
import { bytes, digest, requireThat } from "./identity.js";
const proposalContent = z.strictObject({
	sections: z.array(sectionSchema).min(1).max(16),
	conditions: z.array(z.string().min(1).max(2000)).min(1).max(16),
	evidence: z.array(z.string().min(1).max(160)).max(32),
});
export function createResultOperations<Tx>(
	p: Ports<Tx>,
	limits: ServiceLimits,
) {
	const repo = p.repository;
	function reportResult(tx: Tx, input: unknown, auth: Authority) {
		const r = resultSchema.parse(input);
		requireThat(
			auth.permissions.includes("report") &&
				p.authority.valid(tx, auth, r.evidence) &&
				repo.hasUse(tx, auth.scope, r.buildRef, r.executionRef) &&
				!repo.blocked(tx, r.buildRef),
			"permission_denied",
		);
		const hash = digest(r),
			prior = repo.reportReceipt(tx, auth.scope, r.reportId);
		if (prior) {
			requireThat(prior.digest === hash, "report_conflict");
			return prior;
		}
		const existing = repo.report(tx, auth.scope, r.executionRef);
		requireThat(
			(existing?.revision ?? 0) === r.expectedRevision,
			"result_conflict",
		);
		const result: Report = {
			input: r,
			scope: auth.scope,
			revision: r.expectedRevision + 1,
			digest: hash,
		};
		repo.putReport(tx, result);
		for (const proposal of repo.proposalsByExecution(
			tx,
			auth.scope,
			r.executionRef,
		)) {
			let changed = false;
			const expected = proposal.revision;
			if (proposal.executionVerified) {
				// Source-report mark is only meaningful while the latest report stayed succeeded.
				if (r.outcome !== "succeeded") {
					delete proposal.executionVerified;
					changed = true;
				}
			}
			if (proposal.candidateVerification?.status === "bound") {
				if (
					proposal.candidateVerification.reportDigest !== hash ||
					proposal.candidateVerification.reportRevision !== result.revision
				) {
					proposal.candidateVerification = {
						...proposal.candidateVerification,
						status: "invalidated",
					};
					changed = true;
				}
			}
			if (changed) {
				proposal.revision++;
				repo.putProposal(tx, proposal, expected);
			}
		}
		return { digest: hash, revision: result.revision };
	}
	function prepareReflection(
		tx: Tx,
		executionRef: string,
		auth: Authority,
	): PreparedReflection | null {
		const report = repo.report(tx, auth.scope, executionRef);
		requireThat(
			auth.permissions.includes("report") &&
				report &&
				p.authority.valid(tx, auth, report.input.evidence) &&
				!repo.blocked(tx, report.input.buildRef),
			"permission_denied",
		);
		if (!report.input.improvement) return null;
		let reflection = repo.reflectionByReport(tx, auth.scope, report.digest);
		if (!reflection) {
			reflection = {
				ref: p.id(),
				scope: auth.scope,
				executionRef,
				reportDigest: report.digest,
				buildRef: report.input.buildRef,
				authority: structuredClone(auth),
				reserved: false,
				outcome: "pending",
				proposalRef: null,
				revision: 0,
				inputTokens: null,
				outputTokens: null,
			};
			repo.putReflection(tx, reflection, null);
			repo.link(tx, reflection.ref, reflection.buildRef);
			for (const source of report.input.evidence)
				repo.link(tx, reflection.ref, source);
		}
		const build = repo.build(tx, report.input.buildRef);
		const peers = repo.reportsByBuild(tx, auth.scope, report.input.buildRef);
		const grounding = build
			? {
					buildBody: build.content.body,
					sourceRefs: build.content.decision.sourceRefs,
					dependencyVersions: build.content.dependencies.map((d) => d.version),
					contrast: {
						succeeded: peers
							.filter((p) => p.input.outcome === "succeeded")
							.map((p) => p.input.summary)
							.slice(0, 8),
						failed: peers
							.filter((p) =>
								["failed", "incomplete", "cancelled"].includes(p.input.outcome),
							)
							.map((p) => p.input.summary)
							.slice(0, 8),
					},
				}
			: undefined;
		return { reflection, report, grounding };
	}
	function reserveReflection(tx: Tx, s: PreparedReflection, auth: Authority) {
		requireThat(auth.permissions.includes("report"), "permission_denied");
		const row = repo.reflection(tx, s.reflection.ref),
			current = repo.report(tx, auth.scope, s.report.input.executionRef);
		requireThat(
			row &&
				row.scope === auth.scope &&
				row.authority.epoch === auth.epoch &&
				row.authority.principal === auth.principal &&
				!repo.blocked(tx, row.ref) &&
				p.authority.valid(tx, auth, s.report.input.evidence) &&
				current?.digest === row.reportDigest,
			"stale_result",
		);
		requireThat(
			!row.reserved && row.outcome === "pending",
			"reflection_budget_exceeded",
		);
		const revision = row.revision;
		row.reserved = true;
		row.revision++;
		repo.putReflection(tx, row, revision);
	}
	async function propose(
		s: PreparedReflection,
		context: { signal: AbortSignal; reserve(): Promise<void> },
	) {
		requireThat(s.report.input.improvement, "improvement_not_requested");
		context.signal.throwIfAborted();
		await context.reserve();
		const data = {
			report: s.report.input,
			verification: "実行側の報告。ホストで実証されたという意味ではない",
			...(s.grounding
				? {
						buildBody: s.grounding.buildBody,
						sourceRefs: s.grounding.sourceRefs,
						dependencyVersions: s.grounding.dependencyVersions,
						contrast: s.grounding.contrast,
					}
				: {}),
		};
		requireThat(
			bytes(data) <= limits.reflectionMaxDataBytes,
			"context_budget_exceeded",
		);
		const response = await p.inference.complete(
			{
				system: improvementInstructions,
				data,
				schema: z.toJSONSchema(proposalContent),
				deadlineAt: p.now() + limits.reflectionDeadlineMs,
				maxOutputTokens: limits.reflectionMaxOutputTokens,
				requestRef: s.reflection.ref,
			},
			context.signal,
		);
		const content = proposalContent.parse(response.value);
		requireThat(bytes(content) <= 16384, "context_budget_exceeded");
		return {
			content,
			receipt: response.receipt,
			inputTokens: response.inputTokens,
			outputTokens: response.outputTokens,
		};
	}
	function saveProposal(
		tx: Tx,
		s: PreparedReflection,
		result: Awaited<ReturnType<typeof propose>>,
		auth: Authority,
	) {
		const current = repo.report(tx, auth.scope, s.report.input.executionRef),
			row = repo.reflection(tx, s.reflection.ref);
		requireThat(
			auth.permissions.includes("report") &&
				row &&
				row.scope === auth.scope &&
				row.authority.epoch === auth.epoch &&
				row.authority.principal === auth.principal &&
				row.reserved &&
				!repo.blocked(tx, row.ref) &&
				current?.digest === row.reportDigest &&
				p.authority.valid(tx, auth, s.report.input.evidence) &&
				p.inference.validReceipt(tx, result.receipt),
			"stale_result",
		);
		if (row.outcome === "completed") return repo.proposal(tx, row.proposalRef!);
		requireThat(row.outcome === "pending", "reflection_failed");
		requireThat(
			result.content.evidence.every((e) => s.report.input.evidence.includes(e)),
			"evidence_unavailable",
		);
		const proposal: Proposal = {
			ref: p.id(),
			scope: auth.scope,
			buildRef: s.report.input.buildRef,
			executionRef: s.report.input.executionRef,
			...result.content,
			status: "proposed",
			revision: 0,
		};
		repo.putProposal(tx, proposal, null);
		repo.link(tx, proposal.ref, proposal.buildRef);
		for (const ref of proposal.evidence) repo.link(tx, proposal.ref, ref);
		const revision = row.revision;
		row.outcome = "completed";
		row.proposalRef = proposal.ref;
		row.inputTokens = result.inputTokens;
		row.outputTokens = result.outputTokens;
		row.revision++;
		repo.putReflection(tx, row, revision);
		return proposal;
	}
	function failReflection(tx: Tx, s: PreparedReflection, auth: Authority) {
		requireThat(auth.permissions.includes("report"), "permission_denied");
		const row = repo.reflection(tx, s.reflection.ref);
		requireThat(
			row &&
				row.scope === auth.scope &&
				row.authority.epoch === auth.epoch &&
				row.authority.principal === auth.principal &&
				p.authority.valid(tx, auth, s.report.input.evidence) &&
				!repo.blocked(tx, row.ref),
			"permission_denied",
		);
		if (row.outcome !== "pending") return false;
		const revision = row.revision;
		row.outcome = "failed";
		row.revision++;
		repo.putReflection(tx, row, revision);
		return true;
	}
	function reviewProposal(
		tx: Tx,
		ref: string,
		expectedRevision: number,
		status: "validated" | "rejected" | "withdrawn",
		evidence: string[],
		auth: Authority,
	) {
		const proposal = repo.proposal(tx, ref);
		requireThat(
			auth.permissions.includes("manage") &&
				proposal?.scope === auth.scope &&
				!repo.blocked(tx, ref) &&
				p.authority.valid(tx, auth, evidence),
			"permission_denied",
		);
		requireThat(
			proposal.revision === expectedRevision && proposal.status === "proposed",
			"proposal_conflict",
		);
		if (status === "validated")
			requireThat(evidence.length > 0, "verification_required");
		proposal.status = status;
		proposal.revision++;
		proposal.evidence = [...new Set([...proposal.evidence, ...evidence])];
		repo.putProposal(tx, proposal, expectedRevision);
		for (const source of evidence) repo.link(tx, ref, source);
		return proposal;
	}
	function proposalContentDigest(proposal: Proposal) {
		return digest({
			sections: proposal.sections,
			conditions: proposal.conditions,
			evidence: proposal.evidence,
		});
	}
	function markExecutionVerified(
		tx: Tx,
		proposalRef: string,
		expectedRevision: number,
		auth: Authority,
	) {
		const proposal = repo.proposal(tx, proposalRef);
		requireThat(
			auth.permissions.includes("manage") &&
				proposal?.scope === auth.scope &&
				!repo.blocked(tx, proposalRef) &&
				p.authority.valid(tx, auth, proposal.evidence),
			"permission_denied",
		);
		requireThat(proposal.revision === expectedRevision, "proposal_conflict");
		requireThat(
			proposal.status === "proposed" || proposal.status === "validated",
			"proposal_conflict",
		);
		const report = repo.report(tx, auth.scope, proposal.executionRef);
		requireThat(
			report &&
				report.input.outcome === "succeeded" &&
				report.input.buildRef === proposal.buildRef &&
				repo.hasUse(tx, auth.scope, proposal.buildRef, proposal.executionRef),
			"verification_required",
		);
		// Source-report mark only — does not claim the proposal text was executed.
		proposal.executionVerified = true;
		proposal.revision++;
		repo.putProposal(tx, proposal, expectedRevision);
		return proposal;
	}
	/**
	 * Bind an independent local candidate run to the proposal content digest.
	 * Does not promote or change search ranking. Invalidates when digest drifts.
	 */
	function bindCandidateVerification(
		tx: Tx,
		proposalRef: string,
		expectedRevision: number,
		input: {
			proposalDigest: string;
			outcome: "succeeded" | "failed";
		},
		auth: Authority,
	) {
		const proposal = repo.proposal(tx, proposalRef);
		requireThat(
			auth.permissions.includes("manage") &&
				proposal?.scope === auth.scope &&
				!repo.blocked(tx, proposalRef) &&
				p.authority.valid(tx, auth, proposal.evidence),
			"permission_denied",
		);
		requireThat(proposal.revision === expectedRevision, "proposal_conflict");
		const liveDigest = proposalContentDigest(proposal);
		requireThat(liveDigest === input.proposalDigest, "verification_required");
		const report = repo.report(tx, auth.scope, proposal.executionRef);
		requireThat(
			report &&
				repo.hasUse(tx, auth.scope, proposal.buildRef, proposal.executionRef),
			"verification_required",
		);
		proposal.candidateVerification = {
			status: "bound",
			proposalDigest: liveDigest,
			reportDigest: report.digest,
			reportRevision: report.revision,
			verifierVersion: "candidate_verify.v1",
			outcome: input.outcome,
		};
		proposal.revision++;
		repo.putProposal(tx, proposal, expectedRevision);
		return proposal;
	}
	function candidateVerificationStatus(proposal: Proposal) {
		const mark = proposal.candidateVerification;
		if (!mark) return "unverified" as const;
		if (mark.status === "invalidated") return "invalidated" as const;
		if (mark.proposalDigest !== proposalContentDigest(proposal))
			return "invalidated" as const;
		return mark.status;
	}
	function prepareWorkflow(
		tx: Tx,
		input: {
			buildRef: string;
			executionRef: string;
			taskGoal: string;
			succeededSummaries: string[];
			failedSummaries?: string[];
			trajectories?: {
				action: string;
				observation: string;
				outcome: "succeeded" | "failed" | "incomplete" | "cancelled";
			}[];
			evidence: string[];
		},
		auth: Authority,
	): PreparedWorkflow {
		requireThat(
			auth.permissions.includes("report") &&
				p.authority.valid(tx, auth, input.evidence) &&
				repo.hasUse(tx, auth.scope, input.buildRef, input.executionRef) &&
				!repo.blocked(tx, input.buildRef),
			"permission_denied",
		);
		requireThat(input.succeededSummaries.length >= 1, "verification_required");
		const report = repo.report(tx, auth.scope, input.executionRef);
		const trajectories = (input.trajectories ?? []).slice(0, 16).map((t) => ({
			action: t.action,
			observation: t.observation,
			outcome: t.outcome,
		}));
		const snapshot = {
			buildRef: input.buildRef,
			executionRef: input.executionRef,
			taskGoal: input.taskGoal,
			succeededSummaries: input.succeededSummaries.slice(0, 16),
			failedSummaries: (input.failedSummaries ?? []).slice(0, 16),
			trajectories,
			evidence: [...input.evidence],
			reportDigest: report?.digest ?? null,
			reportRevision: report?.revision ?? null,
		};
		return {
			...snapshot,
			authority: {
				scope: auth.scope,
				principal: auth.principal,
				epoch: auth.epoch,
			},
			inputDigest: digest(snapshot),
		};
	}
	async function induceWorkflow(
		s: PreparedWorkflow,
		context: { signal: AbortSignal; reserve(): Promise<void> },
	) {
		context.signal.throwIfAborted();
		await context.reserve();
		const data = {
			taskGoal: s.taskGoal,
			succeededSummaries: s.succeededSummaries,
			...(s.failedSummaries.length
				? { failedSummaries: s.failedSummaries }
				: {}),
			...(s.trajectories.length ? { trajectories: s.trajectories } : {}),
			evidence: s.evidence,
			reportDigest: s.reportDigest,
			reportRevision: s.reportRevision,
			verification:
				"実行側の要約・観測。ホストで候補そのものを実証したという意味ではない",
		};
		requireThat(
			bytes(data) <= limits.reflectionMaxDataBytes,
			"context_budget_exceeded",
		);
		const response = await p.inference.complete(
			{
				system: workflowInstructions,
				data,
				schema: z.toJSONSchema(proposalContent),
				deadlineAt: p.now() + limits.reflectionDeadlineMs,
				maxOutputTokens: limits.reflectionMaxOutputTokens,
				requestRef: s.executionRef,
			},
			context.signal,
		);
		const content = proposalContent.parse(response.value);
		requireThat(bytes(content) <= 16384, "context_budget_exceeded");
		return {
			content,
			receipt: response.receipt,
			inputTokens: response.inputTokens,
			outputTokens: response.outputTokens,
		};
	}
	function saveWorkflow(
		tx: Tx,
		s: PreparedWorkflow,
		result: Awaited<ReturnType<typeof induceWorkflow>>,
		auth: Authority,
	) {
		requireThat(
			auth.permissions.includes("report") &&
				auth.scope === s.authority.scope &&
				auth.principal === s.authority.principal &&
				auth.epoch === s.authority.epoch &&
				p.authority.valid(tx, auth, s.evidence) &&
				repo.hasUse(tx, auth.scope, s.buildRef, s.executionRef) &&
				!repo.blocked(tx, s.buildRef) &&
				p.inference.validReceipt(tx, result.receipt),
			"stale_result",
		);
		const current = repo.report(tx, auth.scope, s.executionRef);
		requireThat(
			(current?.digest ?? null) === s.reportDigest &&
				(current?.revision ?? null) === s.reportRevision,
			"stale_result",
		);
		requireThat(
			result.content.evidence.every((e) => s.evidence.includes(e)),
			"evidence_unavailable",
		);
		const proposal: Proposal = {
			ref: p.id(),
			scope: auth.scope,
			buildRef: s.buildRef,
			executionRef: s.executionRef,
			...result.content,
			status: "proposed",
			revision: 0,
		};
		repo.putProposal(tx, proposal, null);
		repo.link(tx, proposal.ref, proposal.buildRef);
		for (const ref of proposal.evidence) repo.link(tx, proposal.ref, ref);
		return proposal;
	}
	return {
		reportResult,
		prepareReflection,
		reserveReflection,
		propose,
		saveProposal,
		failReflection,
		reviewProposal,
		markExecutionVerified,
		bindCandidateVerification,
		proposalContentDigest,
		candidateVerificationStatus,
		prepareWorkflow,
		induceWorkflow,
		saveWorkflow,
	};
}
