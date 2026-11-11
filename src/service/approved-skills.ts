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
	assembleApprovedParts,
	canCompose,
	COMPOSITION_VERSION,
} from "./approved-composition.js";
import {
	approvedSkillSchema,
	composedSkillSelectionSchema,
	explorationLanguageSchema,
	explorationSelectionSchema,
	fixedExplorationSelectionSchema,
	skillSelectionSchema,
	singleSkillSelectionSchema,
	type ApprovedComposition,
	type PreparedSkillSelection,
	type SelectedSkill,
} from "../contracts/approved-skills.js";
import { authoritySchema, requestSchema } from "../contracts/schema.js";
import type { Authority, Build, Usage } from "../contracts/types.js";
import type { Ports, ExecutionContext } from "../contracts/ports.js";
import {
	skillSelectionInstructions,
	composedSkillSelectionInstructions,
	compositionReviewInstructions,
	composedExplorationSelectionInstructions,
	explorationSelectionInstructions,
	fixedExplorationSelectionInstructions,
} from "../instructions/selection.js";
import { bytes, digest, requireThat, SkillSmithError } from "./identity.js";
import { renderSkillMarkdown, skillBundleDigest } from "./skill-markdown.js";
import { createUsageTotals } from "./usage.js";
import {
	FIXED_EXPLORATION_REF,
	fixedExploration,
} from "./fixed-exploration.js";

// Selector versions from c205160, when the only fixed exploration SKILL was English.
const englishOnlyExplorationVersion =
	"61cbc900d70118b6ecb578b1c4d62077995df65bc012b1ad9c889b04bc722a29";
const englishOnlyCompositionExplorationVersion =
	"a52af6afd554f761633c59f0933cb88edb3202119d97e54f7fc922d4846190bc";

export interface ReuseBuild {
	template: Pick<Build, "scope" | "revoked" | "content" | "generator">;
	assembled?: ReturnType<typeof assembleApprovedParts>;
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
const compositionReviewSchema = z.discriminatedUnion("approved", [
	z.strictObject({
		approved: z.literal(true),
		checks: z
			.array(
				z.strictObject({
					id: z.string(),
					passage: z.number().int().nonnegative(),
				}),
			)
			.min(1)
			.max(32),
	}),
	z.strictObject({
		approved: z.literal(false),
		reason: z.string().trim().min(1).max(200),
	}),
]);

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
	const selectionInference = () => p.selectionInference ?? p.inference;
	const reviewInference = () =>
		p.compositionReviewInference ?? selectionInference();
	const selectorVersion = digest(skillSelectionInstructions);
	const compositionSelectorVersion = digest([
		composedSkillSelectionInstructions,
		compositionReviewInstructions,
	]);
	const explorationSelectorVersion = digest([
		fixedExplorationSelectionInstructions,
		explorationSelectionInstructions,
	]);
	const compositionExplorationVersion = digest([
		composedExplorationSelectionInstructions,
		compositionReviewInstructions,
	]);
	const compositionVersions = new Set([
		compositionSelectorVersion,
		compositionExplorationVersion,
		englishOnlyCompositionExplorationVersion,
	]);
	const selectionVersions = new Set([
		selectorVersion,
		explorationSelectorVersion,
		englishOnlyExplorationVersion,
		...compositionVersions,
	]);
	const limits = resolveServiceLimits(p.limits);
	const issued = new WeakMap<SelectedSkill, string>();
	function canSelectComposition(
		s: Pick<PreparedSkillSelection, "candidates" | "request">,
	) {
		return (
			!!p.approvedSkills?.compositionCurrent &&
			s.request.limits.modelCalls >= 2 &&
			s.request.task.acceptance.some(
				(item) => item.visibility !== "evaluation",
			) &&
			s.candidates.some((a, index) =>
				s.candidates.slice(index + 1).some((b) => canCompose([a, b])),
			)
		);
	}
	const reviewSubject = (selection: string, bundle: string) =>
		digest({ selection, bundle, instructions: compositionSelectorVersion });
	function compositionApproval(
		request: ApprovedComposition["request"],
		parts: ApprovedComposition["parts"],
		bundleDigest: string,
	): ApprovedComposition {
		return {
			request: {
				task: request.task,
				environment: request.environment,
				audience: request.audience,
			},
			parts,
			bundleDigest,
		};
	}
	function selectionDigest(s: Omit<PreparedSkillSelection, "digest">) {
		return digest({
			selectorVersion: selectionVersion(s),
			catalog: s.catalog,
			request: s.request,
			authority: s.authority,
			candidates: s.candidates.map((c) => ({ ref: c.ref, digest: c.digest })),
		});
	}
	function selectionVersion(s: Omit<PreparedSkillSelection, "digest">) {
		if (canSelectComposition(s))
			return s.exploration
				? compositionExplorationVersion
				: compositionSelectorVersion;
		return s.exploration ? explorationSelectorVersion : selectorVersion;
	}
	function explorationPolicy(
		tx: Tx,
		request: PreparedSkillSelection["request"],
		auth: Authority,
	) {
		if (
			!p.explorationFallback ||
			p.assemblyMode === "legacy" ||
			repo.blocked(tx, FIXED_EXPLORATION_REF)
		)
			return null;
		const policy = p.policy.resolve(tx, request, auth);
		return policy.alreadyPresent &&
			digest(policy.version) === digest(request.environment.policy) &&
			p.policy.current(tx, policy.version)
			? policy
			: null;
	}
	function currentParts(tx: Tx, b: Build, auth: Authority) {
		const mark = b.publication;
		if (!mark?.selectorVersion) return null;
		const composition = mark.composition;
		if (
			composition
				? !compositionVersions.has(mark.selectorVersion) ||
					composition.version !== COMPOSITION_VERSION ||
					composition.parts[0]?.ref !== mark.ref ||
					composition.parts[0]?.digest !== mark.digest
				: !selectionVersions.has(mark.selectorVersion)
		)
			return null;
		if (
			composition &&
			!p.approvedSkills?.compositionCurrent?.(
				tx,
				auth,
				compositionApproval(
					b.content,
					composition.parts,
					composition.bundleDigest,
				),
			)
		)
			return null;
		const parts = [];
		for (const member of composition?.parts ?? [mark]) {
			const r = p.approvedSkills?.get(tx, member.ref);
			if (!r || r.digest !== member.digest || !available(p, tx, r, auth))
				return null;
			parts.push(r);
		}
		return parts;
	}
	function current(tx: Tx, b: Build, auth: Authority) {
		const mark = b.publication;
		if (mark?.exploration) {
			const language = b.content.decision.language;
			return (
				!!p.explorationFallback &&
				p.assemblyMode !== "legacy" &&
				!mark.composition &&
				mark.ref === FIXED_EXPLORATION_REF &&
				explorationLanguageSchema.safeParse(language).success &&
				(mark.selectorVersion === explorationSelectorVersion ||
					mark.selectorVersion === compositionExplorationVersion ||
					(language === "en" &&
						(mark.selectorVersion === englishOnlyExplorationVersion ||
							mark.selectorVersion ===
								englishOnlyCompositionExplorationVersion))) &&
				!repo.blocked(tx, mark.ref) &&
				selectionInference().validReceipt(
					tx,
					mark.receipt,
					mark.selectionDigest,
				)
			);
		}
		return !!currentParts(tx, b, auth);
	}
	function artifact(
		read: <T>(op: (tx: Tx) => T) => T,
		b: Build,
		auth: Authority,
	) {
		return read((tx) => {
			if (b.publication?.exploration) {
				requireThat(current(tx, b, auth), "publication_revoked");
				const { artifact, content } = fixedExploration(
					b.content,
					b.content.policy,
					explorationLanguageSchema.parse(b.content.decision.language),
				);
				requireThat(
					artifact.bundleDigest === b.publication.digest &&
						digest(content) === b.digest &&
						digest(b.content) === b.digest,
					"artifact_mismatch",
				);
				return artifact;
			}
			const parts = currentParts(tx, b, auth);
			requireThat(parts, "publication_revoked");
			const composition = b.publication?.composition;
			if (!composition) return structuredClone(parts[0]!.artifact);
			const assembled = assembleApprovedParts(b.content, parts);
			requireThat(
				assembled.artifact.bundleDigest === composition.bundleDigest &&
					digest(assembled.content) === digest(b.content),
				"artifact_mismatch",
			);
			return assembled.artifact;
		});
	}
	function publishSkill(
		tx: Tx,
		input: {
			buildRef: string;
			applicability: string;
			approvalRef: string;
			compositionGroup?: string;
		},
		auth: Authority,
	) {
		auth = authoritySchema.parse(auth);
		const parsed = z
			.strictObject({
				buildRef: z.string().min(1).max(160),
				applicability: z.string().trim().min(1).max(2000),
				approvalRef: z.string().min(1).max(160),
				compositionGroup: z.string().trim().min(1).max(160).optional(),
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
			...(parsed.compositionGroup
				? { compositionGroup: parsed.compositionGroup }
				: {}),
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
			!record.compositionGroup || canCompose([record]),
			"composition_incompatible",
		);
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
			...(request.task.acceptance.some(
				(clause) => clause.visibility !== "evaluation",
			) && explorationPolicy(tx, request, auth)
				? { exploration: true as const }
				: {}),
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
				...(s.exploration && {
					language: r.template.content.decision.language,
				}),
				originalTask: visibleTask({
					...r.template.content.task,
					situation: undefined,
				}),
				requiredCapabilities: r.template.content.decision.requiredCapabilities,
				...(r.compositionGroup ? { compositionGroup: r.compositionGroup } : {}),
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
		if (!s.candidates.length && !s.exploration) {
			const selected: SelectedSkill = {
				preparedDigest: s.digest,
				decision: { kind: "miss", reason: "no_approved_candidate" },
				receipt: null,
				usage: noUsage(),
			};
			issued.set(selected, digest(selected));
			return selected;
		}
		const composed = canSelectComposition(s);
		const fixedOnly = s.exploration && s.candidates.length === 0;
		const schema = s.exploration
			? fixedOnly
				? fixedExplorationSelectionSchema
				: composed
					? skillSelectionSchema
					: explorationSelectionSchema
			: composed
				? composedSkillSelectionSchema
				: singleSkillSelectionSchema;
		const signal = AbortSignal.any([
			context.signal,
			AbortSignal.timeout(
				Math.max(1, Math.min(s.request.limits.deadlineAt - p.now(), 120000)),
			),
		]);
		const totals = createUsageTotals();
		let modelCalls = 0;
		type Inference = Ports<Tx>["inference"];
		async function infer(
			inference: Inference,
			operation: "skill_selection" | "composition_review",
			input: Omit<
				Parameters<Inference["complete"]>[0],
				"deadlineAt" | "maxOutputTokens"
			>,
		) {
			const bounded = {
				...input,
				deadlineAt: s.request.limits.deadlineAt,
				maxOutputTokens: Math.min(256, s.request.limits.outputTokens),
			};
			requireThat(
				bytes(bounded) <= s.request.limits.inputBytes,
				"context_budget_exceeded",
			);
			signal.throwIfAborted();
			await context.reserve("modelCalls");
			signal.throwIfAborted();
			modelCalls++;
			const start = performance.now();
			let out: Awaited<ReturnType<Inference["complete"]>>;
			try {
				out = await inference.complete(bounded, signal);
			} catch (error) {
				context.noteCall?.({
					kind: "modelCalls",
					operation,
					outcome: "error",
					durationMs: performance.now() - start,
				});
				throw error;
			}
			totals.add(out);
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
				operation,
				outcome: "ok",
				durationMs: performance.now() - start,
				receipt: out.receipt,
				inputTokens: out.inputTokens,
				outputTokens: out.outputTokens,
				reasoningTokens: out.reasoningTokens,
				cachedInputTokens: out.cachedInputTokens,
			});
			signal.throwIfAborted();
			return out;
		}
		const data = skillSelectionInput(s);
		const system = s.exploration
			? fixedOnly
				? fixedExplorationSelectionInstructions
				: composed
					? composedExplorationSelectionInstructions
					: explorationSelectionInstructions
			: composed
				? composedSkillSelectionInstructions
				: skillSelectionInstructions;
		const out = await infer(selectionInference(), "skill_selection", {
			system,
			data,
			schema: z.toJSONSchema(schema),
			requestRef: s.digest,
		});
		let decision = schema.parse(out.value);
		let compositionReview: SelectedSkill["compositionReview"];
		if (decision.kind === "composed") {
			const parts = decision.refs.map((ref) => {
				const part = s.candidates.find((candidate) => candidate.ref === ref);
				requireThat(part, "selection_mismatch");
				return part;
			});
			let assembled: ReuseBuild["assembled"];
			try {
				assembled = assembleApprovedParts(s.request, parts);
				requireThat(
					bytes(assembled.artifact) < s.request.limits.outputBytes,
					"context_budget_exceeded",
				);
			} catch (error) {
				if (!(error instanceof SkillSmithError)) throw error;
				decision = { kind: "miss", reason: error.code };
				assembled = undefined;
			}
			if (assembled) {
				const { bundleDigest, path, content, files } = assembled.artifact;
				const passages = [{ path, content }, ...files]
					.flatMap(({ path, content }) =>
						content
							.split(/\n\s*\n/)
							.filter((block) => block.trim())
							.map((text) => ({ path, text })),
					)
					.map((passage, index) => ({ ...passage, index }));
				const review = await infer(reviewInference(), "composition_review", {
					system: compositionReviewInstructions,
					data: { task: data.task, passages },
					schema: z.toJSONSchema(compositionReviewSchema),
					requestRef: reviewSubject(s.digest, bundleDigest),
				});
				const result = compositionReviewSchema.parse(review.value);
				if (result.approved) {
					const checked = new Set(result.checks.map((check) => check.id));
					const valid =
						result.checks.length === data.task.acceptance.length &&
						data.task.acceptance.every((clause) => checked.has(clause.id)) &&
						result.checks.every((check) => {
							const passage = passages[check.passage];
							return passage && !/^\s*(?:#|---)/.test(passage.text);
						});
					if (valid)
						compositionReview = { receipt: review.receipt, bundleDigest };
					else
						decision = {
							kind: "miss",
							reason: "composition_evidence_incomplete",
						};
				} else decision = { kind: "miss", reason: result.reason };
			}
		}
		const selected: SelectedSkill = {
			preparedDigest: s.digest,
			decision,
			receipt: out.receipt,
			...(compositionReview ? { compositionReview } : {}),
			usage: {
				modelCalls,
				sourceCalls: 0,
				...totals.snapshot(),
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
			decision.kind !== "miss" &&
				selected.receipt &&
				selectionInference().validReceipt(tx, selected.receipt, s.digest),
			"selection_unavailable",
		);
		if (decision.kind === "explore") {
			const policy = s.exploration && explorationPolicy(tx, s.request, auth);
			requireThat(policy, "exploration_unavailable");
			const assembled = fixedExploration(s.request, policy, decision.language);
			return submit(tx, s.request, auth, {
				template: {
					content: assembled.content,
					scope: auth.scope,
					revoked: false,
				},
				assembled,
				expiresAt: p.now() + limits.buildTtlMs,
				usage: selected.usage,
				publication: {
					ref: FIXED_EXPLORATION_REF,
					digest: assembled.artifact.bundleDigest,
					selectorVersion: selectionVersion(s),
					selectionDigest: s.digest,
					receipt: selected.receipt,
					assessment: decision.assessment,
					exploration: true,
				},
			});
		}
		const refs = decision.kind === "composed" ? decision.refs : [decision.ref];
		const parts = refs.map((ref) => {
			const chosen = s.candidates.find((r) => r.ref === ref);
			const r = chosen && p.approvedSkills?.get(tx, chosen.ref);
			requireThat(
				r &&
					chosen &&
					r.digest === chosen.digest &&
					available(p, tx, r, auth) &&
					compatible(r, s.request),
				"publication_revoked",
			);
			return r;
		});
		const r = parts[0]!;
		const assembly =
			decision.kind === "composed"
				? assembleApprovedParts(s.request, parts)
				: undefined;
		const review = selected.compositionReview;
		if (assembly) {
			requireThat(
				review?.bundleDigest === assembly.artifact.bundleDigest &&
					reviewInference().validReceipt(
						tx,
						review.receipt,
						reviewSubject(s.digest, review.bundleDigest),
					),
				"composition_review_unavailable",
			);
			requireThat(
				p.approvedSkills?.compositionCurrent?.(
					tx,
					auth,
					compositionApproval(
						s.request,
						parts.map(({ ref, digest }) => ({ ref, digest })),
						assembly.artifact.bundleDigest,
					),
				),
				"composition_not_approved",
			);
		}
		return submit(tx, s.request, auth, {
			template: r.template,
			assembled: assembly,
			expiresAt: Math.min(...parts.map((p) => p.expiresAt)),
			usage: selected.usage,
			publication: {
				ref: r.ref,
				digest: r.digest,
				selectorVersion: selectionVersion(s),
				receipt: selected.receipt,
				assessment: decision.assessment,
				...(assembly
					? {
							composition: {
								version: COMPOSITION_VERSION,
								parts: parts.map(({ ref, digest }) => ({ ref, digest })),
								bundleDigest: assembly.artifact.bundleDigest,
								reviewReceipt: review!.receipt,
							},
						}
					: {}),
				selectionDigest: digest({
					request: s.request,
					authority: auth,
					decision,
					receipt: selected.receipt,
					compositionReview: review,
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
					? selectionInference().validReceipt(tx, selected.receipt, s.digest)
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
