import { prepareApprovedCatalog } from "./approved-catalog.js";
import {
	available,
	compatible,
	checkArtifact,
	publicationDigest,
} from "./approved-publication.js";
export { publicationDigest } from "./approved-publication.js";
import { resolveServiceLimits } from "../contracts/limits.js";
import { z } from "zod";
import {
	approvedSkillSchema,
	skillSelectionSchema,
	type PreparedSkillSelection,
	type SelectedSkill,
} from "../contracts/approved-skills.js";
import { authoritySchema, requestSchema } from "../contracts/schema.js";
import type { Authority, Build, Usage } from "../contracts/types.js";
import type { Ports, ExecutionContext } from "../contracts/ports.js";
import { skillSelectionInstructions } from "../instructions/selection.js";
import { bytes, digest, requireThat } from "./identity.js";
import { renderSkillMarkdown, skillBundleDigest } from "./skill-markdown.js";

export interface ReuseBuild {
	template: Build;
	expiresAt: number;
	publication: NonNullable<Build["publication"]>;
	usage: Usage;
}
const noUsage = (): Usage => ({
	modelCalls: 0,
	sourceCalls: 0,
	inputTokens: null,
	outputTokens: null,
	reasoningTokens: null,
	cachedInputTokens: null,
});
export function createApprovedSkillOperations<Tx>(
	p: Ports<Tx>,
	usable: (tx: Tx, b: Build, auth: Authority) => boolean,
	submit: (
		tx: Tx,
		request: unknown,
		auth: Authority,
		reuse?: ReuseBuild,
		rejectPublishedCache?: boolean,
	) => import("../contracts/types.js").Reply,
) {
	const repo = p.repository;
	const selectorVersion = digest(skillSelectionInstructions);
	const limits = resolveServiceLimits(p.limits);
	const issued = new WeakMap<SelectedSkill, string>();
	function selectionDigest(s: Omit<PreparedSkillSelection, "digest">) {
		return digest({
			selectorVersion,
			catalog: s.catalog,
			request: s.request,
			authority: s.authority,
			candidates: s.candidates.map((c) => ({ ref: c.ref, digest: c.digest })),
		});
	}
	function current(tx: Tx, b: Build, auth: Authority) {
		const mark = b.publication;
		if (!mark) return true;
		const r = p.approvedSkills?.get(tx, mark.ref);
		return (
			mark.selectorVersion === selectorVersion &&
			!!r &&
			r.digest === mark.digest &&
			available(p, tx, r, auth)
		);
	}
	function artifact(
		read: <T>(op: (tx: Tx) => T) => T,
		b: Build,
		auth: Authority,
	) {
		return read((tx) => {
			requireThat(current(tx, b, auth), "publication_revoked");
			return structuredClone(
				p.approvedSkills!.get(tx, b.publication!.ref)!.artifact,
			);
		});
	}
	function publishSkill(
		tx: Tx,
		input: { buildRef: string; applicability: string; approvalRef: string },
		auth: Authority,
	) {
		auth = authoritySchema.parse(auth);
		const parsed = z
			.strictObject({
				buildRef: z.string().min(1).max(160),
				applicability: z.string().trim().min(1).max(2000),
				approvalRef: z.string().min(1).max(160),
			})
			.parse(input);
		const build = repo.build(tx, parsed.buildRef);
		requireThat(
			p.approvedSkills &&
				auth.permissions.includes("manage") &&
				build &&
				!build.publication &&
				usable(tx, build, auth),
			"permission_denied",
		);
		// Approval is a host-owned attestation of the exact reviewed bundle and applicability.
		// Structural validity or the origin execution result alone must never promote a skill.
		const rendered = renderSkillMarkdown(
			build.content,
			undefined,
			p.skillMarkdown,
		);
		const record = approvedSkillSchema.parse({
			ref: p.id(),
			scope: auth.scope,
			approvalRef: parsed.approvalRef,
			applicability: parsed.applicability,
			template: build,
			artifact: {
				...rendered,
				files: rendered.files ?? [],
				bundleDigest:
					rendered.bundleDigest ??
					skillBundleDigest(rendered, rendered.files ?? []),
			},
			expiresAt: build.expiresAt,
			digest: "pending",
		});
		record.digest = publicationDigest(record);
		checkArtifact(record);
		requireThat(
			p.approvedSkills.authorizePublication(tx, auth, record) &&
				p.approvedSkills.approvalCurrent(tx, record),
			"publication_not_approved",
		);
		p.approvedSkills.put(tx, record);
		repo.link(tx, record.ref, build.ref);
		repo.link(tx, record.ref, record.approvalRef);
		return {
			ref: record.ref,
			digest: record.digest,
			bundleDigest: record.artifact.bundleDigest,
		};
	}
	function prepareSkillSelection(
		tx: Tx,
		input: unknown,
		authority: Authority,
	): PreparedSkillSelection {
		const request = requestSchema.parse(input),
			auth = authoritySchema.parse(authority);
		requireThat(
			auth.permissions.includes("build") &&
				p.authority.valid(tx, auth, auth.sourceRefs),
			"permission_denied",
		);
		requireThat(request.limits.deadlineAt > p.now(), "deadline_exceeded");
		const { candidates, catalog } = prepareApprovedCatalog(
			p,
			tx,
			request,
			auth,
			limits.approvedScanLimit,
		);
		const s = {
			request,
			authority: auth,
			candidates,
			catalog,
		};
		return structuredClone({ ...s, digest: selectionDigest(s) });
	}
	/** Public metadata only: private Build identifiers, origin principals and evaluation clauses stay internal. */
	function skillSelectionInput(s: PreparedSkillSelection) {
		const visibleTask = (task: Build["content"]["task"]) => ({
			...task,
			references: [],
			acceptance: task.acceptance.filter((c) => c.visibility !== "evaluation"),
			constraints: task.constraints.filter(
				(c) => c.visibility !== "evaluation",
			),
		});
		return {
			catalog: s.catalog,
			task: visibleTask(s.request.task),
			environment: s.request.environment,
			candidates: s.candidates.map((r) => ({
				ref: r.ref,
				applicability: r.applicability,
				name: r.artifact.name,
				originalTask: visibleTask(r.template.content.task),
				requiredCapabilities: r.template.content.decision.requiredCapabilities,
			})),
		};
	}
	async function selectSkill(
		s: PreparedSkillSelection,
		context: ExecutionContext,
	): Promise<SelectedSkill> {
		requireThat(selectionDigest(s) === s.digest, "selection_mismatch");
		for (const candidate of s.candidates) checkArtifact(candidate);
		context.signal.throwIfAborted();
		requireThat(s.request.limits.deadlineAt > p.now(), "deadline_exceeded");
		if (!s.candidates.length) {
			const selected: SelectedSkill = {
				preparedDigest: s.digest,
				decision: { kind: "miss", reason: "no_approved_candidate" },
				receipt: null,
				usage: noUsage(),
			};
			issued.set(selected, digest(selected));
			return selected;
		}
		const input = {
			system: skillSelectionInstructions,
			data: skillSelectionInput(s),
			schema: z.toJSONSchema(skillSelectionSchema),
			requestRef: s.digest,
			deadlineAt: s.request.limits.deadlineAt,
			maxOutputTokens: Math.min(256, s.request.limits.outputTokens),
		};
		requireThat(
			bytes(input) <= s.request.limits.inputBytes,
			"context_budget_exceeded",
		);
		await context.reserve("modelCalls");
		const signal = AbortSignal.any([
			context.signal,
			AbortSignal.timeout(
				Math.max(1, Math.min(s.request.limits.deadlineAt - p.now(), 120000)),
			),
		]);
		const start = performance.now();
		let out: Awaited<ReturnType<typeof p.inference.complete>>;
		try {
			out = await p.inference.complete(input, signal);
		} catch (error) {
			context.noteCall?.({
				kind: "modelCalls",
				operation: "skill_selection",
				outcome: "error",
				durationMs: performance.now() - start,
			});
			throw error;
		}
		await context.noteUsage?.({
			receipt: out.receipt,
			inputTokens: out.inputTokens,
			outputTokens: out.outputTokens,
			reasoningTokens: out.reasoningTokens,
			cachedInputTokens: out.cachedInputTokens,
			callKind: "selection",
		});
		context.noteCall?.({
			kind: "modelCalls",
			operation: "skill_selection",
			outcome: "ok",
			durationMs: performance.now() - start,
			receipt: out.receipt,
			inputTokens: out.inputTokens,
			outputTokens: out.outputTokens,
			reasoningTokens: out.reasoningTokens,
			cachedInputTokens: out.cachedInputTokens,
		});
		signal.throwIfAborted();
		const selected: SelectedSkill = {
			preparedDigest: s.digest,
			decision: skillSelectionSchema.parse(out.value),
			receipt: out.receipt,
			usage: {
				...noUsage(),
				modelCalls: 1,
				inputTokens: out.inputTokens,
				outputTokens: out.outputTokens,
				reasoningTokens: out.reasoningTokens ?? null,
				cachedInputTokens: out.cachedInputTokens ?? null,
			},
		};
		issued.set(selected, digest(selected));
		return selected;
	}
	function bindSkillSelection(
		tx: Tx,
		s: PreparedSkillSelection,
		selected: SelectedSkill,
		authority: Authority,
	) {
		const auth = authoritySchema.parse(authority);
		requireThat(
			issued.get(selected) === digest(selected),
			"selection_not_attested",
		);
		requireThat(
			selectionDigest(s) === s.digest &&
				selected.preparedDigest === s.digest &&
				digest(auth) === digest(s.authority),
			"selection_mismatch",
		);
		const decision = skillSelectionSchema.parse(selected.decision);
		requireThat(
			decision.kind === "selected" &&
				selected.receipt &&
				p.inference.validReceipt(tx, selected.receipt),
			"selection_unavailable",
		);
		const chosen = s.candidates.find((r) => r.ref === decision.ref),
			r = chosen && p.approvedSkills?.get(tx, chosen.ref);
		requireThat(
			r &&
				chosen &&
				r.digest === chosen.digest &&
				available(p, tx, r, auth) &&
				compatible(r, s.request),
			"publication_revoked",
		);
		return submit(tx, s.request, auth, {
			template: r.template,
			expiresAt: r.expiresAt,
			usage: selected.usage,
			publication: {
				ref: r.ref,
				digest: r.digest,
				selectorVersion,
				receipt: selected.receipt,
				assessment: decision.assessment,
				selectionDigest: digest({
					request: s.request,
					authority: auth,
					decision,
					receipt: selected.receipt,
				}),
			},
		});
	}
	/** Honor a current rejection instead of silently replaying a prior publication selection. */
	function submitAfterSkillMiss(
		tx: Tx,
		s: PreparedSkillSelection,
		selected: SelectedSkill,
		authority: Authority,
	) {
		const auth = authoritySchema.parse(authority);
		requireThat(
			issued.get(selected) === digest(selected) &&
				selectionDigest(s) === s.digest &&
				selected.preparedDigest === s.digest &&
				digest(auth) === digest(s.authority),
			"selection_not_attested",
		);
		requireThat(
			selected.decision.kind === "miss" &&
				(selected.receipt
					? p.inference.validReceipt(tx, selected.receipt)
					: s.candidates.length === 0),
			"selection_unavailable",
		);
		return submit(tx, s.request, auth, undefined, true);
	}

	return {
		current,
		artifact,
		operations: {
			publishSkill,
			prepareSkillSelection,
			skillSelectionInput,
			selectSkill,
			bindSkillSelection,
			submitAfterSkillMiss,
		},
	};
}
