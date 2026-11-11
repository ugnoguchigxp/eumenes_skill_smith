import { createEvidenceSearch } from "./evidence-search.js";
import { createUsageTotals } from "./usage.js";
import { assembleSkillBody } from "./skill-document.js";
import { legacyExecutionBody } from "./legacy-content.js";
export { bodyTail } from "./legacy-content.js";
import { validateModelMarkdown } from "./model-markdown.js";
import { z } from "zod";
import { renderSkillMarkdown, checkLocalizedHost } from "./skill-markdown.js";
import {
	semanticReviewInstructions,
	disclosureInstructions,
	leanReviewInstructions,
} from "../instructions/build.js";
import {
	CONTRACT,
	compactReadySchema,
	leanDocumentSchema,
	sourceReviewSchema,
	nonSourceAdditionsSchema,
	skillDocumentSchema,
	skillPresentationSchema,
	legacyModelTurnSchema,
} from "../contracts/schema.js";
import type { Ports, ExecutionContext } from "../contracts/ports.js";
import type {
	Build,
	Decision,
	Evidence,
	Executed,
	Prepared,
	ReadyDecision,
} from "../contracts/types.js";
import {
	discloseEvidence,
	evidenceCardView,
	spotlightUntrusted,
} from "./disclosure.js";
import {
	rejectDisclosedBodyRewrite,
	resolveAssembly,
	toStoredReady,
} from "./assembly.js";
import { bytes, digest, requireThat, SkillSmithError } from "./identity.js";

export function checkDecision(
	decision: ReadyDecision,
	evidence: Evidence[],
	p: Prepared,
	options?: { rejectBodyRewrite?: boolean },
) {
	if (
		decision.localizedInstructions !== undefined &&
		decision.strategy === "provisional"
	)
		requireThat(
			!!decision.domainAnchors?.length,
			"provisional_domain_anchors_missing",
		);
	if (
		decision.localizedInstructions !== undefined &&
		decision.strategy === "compose"
	)
		requireThat(
			!!decision.interactions?.length,
			"composition_interactions_missing",
		);
	const selected = decision.sourceRefs.map((ref) => {
		const e = evidence.find((e) => e.ref === ref);
		requireThat(e && e.status === "active" && e.complete, "source_unavailable");
		requireThat(
			e.scope === "shared" || e.scope === p.record.authority.scope,
			"scope_mismatch",
		);
		return e;
	});
	requireThat(
		decision.assumptions.every((a) => !a.mandatory || a.resolved),
		"required_condition_missing",
	);
	const capabilities = new Set(
		p.record.request.environment.capabilities.map((c) => c.id),
	);
	requireThat(
		decision.requiredCapabilities.every((c) => capabilities.has(c)),
		"capability_missing",
	);
	requireThat(
		new Set(decision.sections.map((s) => s.id)).size ===
			decision.sections.length,
		"duplicate_sections",
	);
	if (decision.strategy === "reuse")
		requireThat(
			selected.length === 1 &&
				!decision.sections.length &&
				!decision.patches.length,
			"invalid_reuse",
		);
	else if (decision.strategy === "adapt") {
		requireThat(selected.length === 1, "invalid_adaptation");
		requireThat(
			!!decision.sections.length !== !!decision.patches.length,
			"invalid_adaptation",
		);
	} else {
		requireThat(
			decision.sections.length > 0 && !decision.patches.length,
			"invalid_composition",
		);
		if (decision.strategy === "compose")
			requireThat(selected.length > 0, "source_missing");
	}
	if (decision.patches.length) {
		const patched = new Set<string>();
		for (const patch of decision.patches) {
			const e = selected.find((e) => e.ref === patch.sourceRef);
			const key = patch.sourceRef + ":" + patch.sectionId;
			requireThat(
				e?.sections?.some((s) => s.id === patch.sectionId) && !patched.has(key),
				"section_missing",
			);
			patched.add(key);
		}
	}
	if (options?.rejectBodyRewrite)
		rejectDisclosedBodyRewrite(decision, evidence);
	return selected;
}
export function buildContent(
	p: Prepared,
	d: ReadyDecision,
	evidence: Evidence[],
): Build["content"] {
	const selected = checkDecision(d, evidence, p);
	const { request } = p.record;
	const content: Build["content"] = {
		contractVersion: CONTRACT,
		task: request.task,
		audience: request.audience,
		environment: request.environment,
		body: "",
		decision: d,
		dependencies: selected.map(
			({
				body: _body,
				sections: _sections,
				retrievedAt: _retrievedAt,
				...rest
			}) => rest,
		),
		policy: p.policy,
	};
	if (d.localizedInstructions !== undefined) {
		validateModelMarkdown(d.title ?? "", d.localizedInstructions);
		content.body = assembleSkillBody(
			content,
			d.localizedInstructions,
			d.name ?? "skill",
		);
	} else
		content.body = legacyExecutionBody(request.task, p.policy, d, selected);
	return content;
}

export async function executeBuild<Tx>(
	ports: Ports<Tx>,
	p: Prepared,
	context: ExecutionContext,
): Promise<Executed> {
	const r = p.record,
		request = r.request,
		{ signal, noteUsage } = context;
	let sharedModelCallsUsed = r.usage.modelCalls;
	let sharedSourceCallsUsed = r.usage.sourceCalls;
	const reserve: ExecutionContext["reserve"] = async (kind) => {
		await context.reserve(kind);
		if (kind === "modelCalls") sharedModelCallsUsed++;
		else sharedSourceCallsUsed++;
	};
	const checkpoint = () => {
		signal.throwIfAborted();
		requireThat(ports.now() < request.limits.deadlineAt, "deadline_exceeded");
	};
	const call = async <T>(f: () => Promise<T>) => {
		checkpoint();
		await reserve("sourceCalls");
		checkpoint();
		return f();
	};
	const usage = createUsageTotals();
	const reportedUsage = usage.snapshot;
	const sourceContext: ExecutionContext = {
		...context,
		reserve,
		noteUsage: async (usageObservation) => {
			usage.add(usageObservation);
			await noteUsage?.({ ...usageObservation, ...reportedUsage() });
		},
	};
	const complete = async (
		input: Parameters<Ports<Tx>["inference"]["complete"]>[0],
		operation: "build" | "semantic-review",
	) => {
		await reserve("modelCalls");
		checkpoint();
		const started = performance.now();
		let answer: Awaited<ReturnType<Ports<Tx>["inference"]["complete"]>>;
		try {
			answer = await ports.inference.complete(input, signal);
		} catch (error) {
			context.noteCall?.({
				kind: "modelCalls",
				operation,
				outcome: "error",
				durationMs: performance.now() - started,
			});
			throw error;
		}
		const durationMs = performance.now() - started;
		usage.add(answer);
		// Persist observed provider usage before a diagnostic callback can fail.
		await noteUsage?.({
			...reportedUsage(),
			receipt: answer.receipt,
			callKind: "build",
		});
		context.noteCall?.({
			kind: "modelCalls",
			operation,
			outcome: "ok",
			durationMs,
			receipt: answer.receipt,
			inputTokens: answer.inputTokens,
			outputTokens: answer.outputTokens,
			reasoningTokens: answer.reasoningTokens,
			cachedInputTokens: answer.cachedInputTokens,
		});
		checkpoint();
		return answer;
	};
	const metered = ports.assemblyMode !== "legacy" && ports.source?.meteredCalls;
	const sourceCall = async <T>(f: () => Promise<T>) => {
		checkpoint();
		return metered ? f() : call(f);
	};
	const evidenceIO = createEvidenceSearch(ports, p, {
		call,
		sourceCall,
		checkpoint,
		reserve,
		sourceContext,
		metered,
	});
	const runSearch = evidenceIO.search;

	let state = await runSearch(request.task.goal, r.authority.searchTask, null);
	let disclosed: ReturnType<typeof discloseEvidence> = [];
	let disclosureTrace: {
		rounds: number;
		last: {
			addedBytes: number;
			newSectionIds: string[];
			duplicateOnly: boolean;
			unknownRefs: string[];
		} | null;
		disclosedRefs: string[];
		disclosedSectionIds: string[];
	} = {
		rounds: 0,
		last: null,
		disclosedRefs: [],
		disclosedSectionIds: [],
	};

	const buildData = () => {
		const {
			candidates,
			evidence,
			successors,
			externalUsed,
			sourceSearch,
			sourceNotices,
			reSearch,
		} = state;
		const candidateCards = (
			assembly.mode === "legacy"
				? <T extends { ref: string }>(items: T[]) => ({ items })
				: spotlightUntrusted
		)(
			candidates.map((e) => ({
				ref: e.ref,
				version: e.version,
				title: e.title,
				status: e.status,
				complete: e.complete,
				...(e.revisionOnly ? { completenessPending: true } : {}),
				external: e.external,
				scope: e.scope,
			})),
		).items;
		return {
			task: request.task,
			...(assembly.mode === "legacy"
				? {}
				: {
						outputBudget: {
							maxOutputTokens: request.limits.outputTokens,
							maxReplyBytes: request.limits.outputBytes,
						},
					}),
			environment: request.environment,
			audience: request.audience,
			policy: p.policy,
			candidateCards,
			evidenceIndex:
				assembly.mode === "legacy"
					? evidence.map(evidenceCardView)
					: spotlightUntrusted([
							...candidates.map((card) =>
								evidenceCardView(
									evidence.find((e) => e.ref === card.ref) ?? card,
								),
							),
							...evidence
								.filter((e) => !candidates.some((c) => c.ref === e.ref))
								.map(evidenceCardView),
						]).items,
			untrustedEvidence: spotlightUntrusted(disclosed),
			disclosureProgress: {
				rounds: disclosureTrace.rounds,
				disclosedRefs: disclosureTrace.disclosedRefs,
				disclosedSectionIds: disclosureTrace.disclosedSectionIds,
				last: disclosureTrace.last,
				modelCallsLimit: request.limits.modelCalls,
				modelCallsUsed: modelCallsUsed,
				...(assembly.mode === "legacy"
					? {}
					: {
							sourceCallsLimit: request.limits.sourceCalls,
							sourceCallsUsed: sharedSourceCallsUsed,
						}),
			},
			freshness: (assembly.mode === "legacy"
				? <T extends { ref: string }>(items: T[]) => ({ items })
				: spotlightUntrusted)(
				evidence.map((e) => ({
					ref: e.ref,
					status: e.status,
					retrievedAt: e.retrievedAt ?? null,
					supersededBy: e.supersededBy ?? null,
					version: e.version,
				})),
			).items,
			search: {
				...(assembly.mode === "legacy"
					? {}
					: { untrusted: true, datamark: "<<UNTRUSTED>>" }),
				externalUsed,
				...(successors.length ? { successors } : {}),
				...(reSearch.length ? { reSearch } : {}),
				...(sourceNotices || sourceSearch
					? {
							external: {
								...(assembly.mode === "legacy"
									? {}
									: { untrusted: true, datamark: "<<UNTRUSTED>>" }),
								warnings: (
									sourceNotices?.warnings ?? sourceSearch!.warnings
								).filter((w) =>
									w.refs.every((ref) => candidates.some((c) => c.ref === ref)),
								),
								omittedWarnings: (
									sourceNotices?.warnings ?? sourceSearch!.warnings
								).filter(
									(w) =>
										!w.refs.every((ref) =>
											candidates.some((c) => c.ref === ref),
										),
								).length,
								degraded: sourceNotices?.degraded ?? sourceSearch!.degraded,
								truncated: sourceNotices?.truncated ?? sourceSearch!.truncated,
							},
						}
					: {}),
			},
		};
	};

	let modelCallsUsed = 0;
	let decision: Decision | undefined, receipt: string | undefined;

	let repair: { code: string; instruction: string } | undefined;
	let lastFailure = "invalid_model_output";
	let reSearchUsed = false;
	const assembly = resolveAssembly(ports.assemblyMode ?? "baseline");
	const lean = assembly.mode === "lean";
	if (lean || assembly.mode === "compact") {
		// Reserve room for validation after build and at delivery. Rank limits reads,
		// while the model can still disclose other candidates and determines applicability.
		const eligible = state.candidates.filter(
			(c) =>
				c.status === "active" &&
				(c.complete || c.revisionOnly) &&
				(c.scope === "shared" || c.scope === r.authority.scope),
		);
		const prefetchLimit =
			state.candidates.length > request.limits.documents
				? request.limits.documents - 1
				: request.limits.documents;
		for (const { ref } of eligible.slice(0, lean ? 2 : 1)) {
			if (!state.evidence.some((e) => e.ref === ref)) {
				if (
					state.evidence.length >= prefetchLimit ||
					sharedSourceCallsUsed + 4 >= request.limits.sourceCalls
				)
					break;
				try {
					await evidenceIO.disclose(state, [ref]);
				} catch (error) {
					checkpoint();
					if (
						error instanceof SkillSmithError &&
						!["source_revoked", "source_contract_violation"].includes(
							error.code,
						)
					)
						throw error;
					continue;
				}
			}
			const doc = state.evidence.find((e) => e.ref === ref);
			if (doc?.status !== "active" || !doc.complete) continue;
			const packet = discloseEvidence([doc], [{ ref }], true);
			// Keep overlarge documents available for explicit section disclosure.
			if (
				bytes([...disclosed, ...packet]) <=
				Math.min(16_384, request.limits.inputBytes / 4)
			) {
				disclosed.push(...packet);
				disclosureTrace.disclosedRefs.push(ref);
				disclosureTrace.disclosedSectionIds.push(
					...(doc.sections ?? []).map((s) => ref + "#" + s.id),
				);
			}
		}
	}
	let currentBuildTurn = assembly.mode !== "baseline";
	for (let attempt = 0; attempt < request.limits.modelCalls; attempt++) {
		checkpoint();
		if (
			(lean || assembly.mode === "compact") &&
			sharedModelCallsUsed + 1 >= request.limits.modelCalls
		)
			break;
		modelCallsUsed = sharedModelCallsUsed + 1;
		const turnSchema = currentBuildTurn
			? assembly.turnSchema
			: legacyModelTurnSchema;
		const instructions = currentBuildTurn
			? assembly.instructions
			: disclosureInstructions;
		const data = repair ? { ...buildData(), repair } : buildData();
		requireThat(
			bytes(data) + new TextEncoder().encode(instructions).length <
				request.limits.inputBytes,
			"context_budget_exceeded",
		);
		const modelInput = {
			system: instructions,
			data,
			schema: z.toJSONSchema(turnSchema),
			deadlineAt: request.limits.deadlineAt,
			maxOutputTokens: request.limits.outputTokens,
			requestRef: r.ref,
		};
		requireThat(
			bytes(modelInput) <= request.limits.inputBytes,
			"context_budget_exceeded",
		);
		const answer = await complete(modelInput, "build");
		receipt = answer.receipt;

		const parsed = turnSchema.safeParse(answer.value);
		if (!parsed.success) {
			lastFailure = "invalid_model_output";
			repair = {
				code: "invalid_output",
				instruction:
					"前回の出力は採用されていない。元の目的・制約を保ちschemaに従って返す。",
			};
			continue;
		}
		const turn = parsed.data;
		if (!currentBuildTurn && turn.kind === "ready") {
			// Never promote a legacy ready response to a current artifact.
			currentBuildTurn = true;
			continue;
		}
		if (turn.kind === "re_search") {
			if (reSearchUsed) {
				lastFailure = "invalid_model_output";
				repair = {
					code: "re_search_limit",
					instruction:
						"再検索は予算内で1回まで。ready・needs_input・unavailable・discloseのいずれかを返す。",
				};
				continue;
			}
			reSearchUsed = true;
			repair = undefined;
			// Local registry may use the model query; external SourcePort must keep TrustedContext.searchTask only.
			const previousEvidence = state.evidence;
			state = await runSearch(turn.query, r.authority.searchTask, state);
			const retained = new Set(
				state.evidence
					.filter((e) => previousEvidence.includes(e))
					.map((e) => e.ref),
			);
			disclosed = disclosed.filter((item) => retained.has(item.ref));
			disclosureTrace.disclosedRefs = disclosed.map((item) => item.ref);
			disclosureTrace.disclosedSectionIds = disclosed.flatMap((item) =>
				(item.sections ?? []).map((section) => item.ref + "#" + section.id),
			);
			disclosureTrace.last = null;
			continue;
		}
		if (turn.kind === "disclose") {
			const unknownRefs = turn.items
				.map((i) => i.ref)
				.filter(
					(ref) =>
						!state.evidence.some((e) => e.ref === ref) &&
						!state.candidates.some((c) => c.ref === ref),
				);
			if (!turn.items.length || unknownRefs.length === turn.items.length) {
				lastFailure = "invalid_model_output";
				repair = {
					code: "disclose_unknown",
					instruction:
						"disclose は取得済み evidenceIndex の ref／sectionIds だけを指定する。空や未知だけは採用されない。",
				};
				continue;
			}
			repair = undefined;
			currentBuildTurn = true;
			await evidenceIO.disclose(
				state,
				turn.items.map((item) => item.ref),
			);
			const beforeBytes = bytes(disclosed);
			const beforeSections = new Set(
				disclosed.flatMap(
					(d) => d.sections?.map((s) => d.ref + "#" + s.id) ?? [],
				),
			);
			const next = discloseEvidence(
				state.evidence,
				turn.items.filter((i) => state.evidence.some((e) => e.ref === i.ref)),
				assembly.mode !== "legacy",
			);
			const byRef = new Map(disclosed.map((d) => [d.ref, d]));
			for (const item of next) {
				const prior = byRef.get(item.ref);
				if (!prior) {
					byRef.set(item.ref, item);
					continue;
				}
				if (item.sections?.length) {
					const ids = new Set(prior.sections?.map((s) => s.id) ?? []);
					const merged = [...(prior.sections ?? [])];
					for (const s of item.sections) {
						if (!ids.has(s.id)) {
							ids.add(s.id);
							merged.push(s);
						}
					}
					byRef.set(item.ref, {
						...prior,
						sections: merged,
						body: item.body ?? prior.body,
					});
				} else if (item.body !== undefined) {
					byRef.set(item.ref, { ...prior, body: item.body });
				}
			}
			disclosed = [...byRef.values()];
			const afterSections = disclosed.flatMap(
				(d) => d.sections?.map((s) => d.ref + "#" + s.id) ?? [],
			);
			const newSectionIds = afterSections.filter(
				(id) => !beforeSections.has(id),
			);
			const addedBytes = Math.max(0, bytes(disclosed) - beforeBytes);
			disclosureTrace = {
				rounds: disclosureTrace.rounds + 1,
				last: {
					addedBytes,
					newSectionIds,
					duplicateOnly: addedBytes === 0 && newSectionIds.length === 0,
					unknownRefs,
				},
				disclosedRefs: disclosed.map((d) => d.ref),
				disclosedSectionIds: afterSections,
			};
			continue;
		}
		let candidate: Decision = turn as Decision;
		if (candidate.kind === "ready") {
			try {
				if (assembly.mode === "compact") {
					const compact = compactReadySchema.safeParse(turn);
					requireThat(compact.success, "invalid_model_output");
					requireThat(compact.data.coverage !== "unclear", "invalid_coverage");
					if (compact.data.coverage === "absent")
						requireThat(!!compact.data.exploration, "invalid_exploration");
					if (compact.data.coverage !== "absent")
						requireThat(!compact.data.exploration, "invalid_exploration");
					candidate = toStoredReady(compact.data);
				}
				if (
					assembly.mode !== "legacy" &&
					(candidate.strategy === "reuse" || candidate.strategy === "adapt")
				) {
					for (const ref of candidate.sourceRefs) {
						const e = state.evidence.find((e) => e.ref === ref);
						const seen = disclosed.find((d) => d.ref === ref);
						requireThat(
							e &&
								seen &&
								seen.body === e.body &&
								(e.sections ?? []).every((section) =>
									seen.sections?.some(
										(s) => s.id === section.id && s.body === section.body,
									),
								),
							"source_not_disclosed",
						);
					}
				}
				checkLocalizedHost(request.task, candidate);
				checkDecision(candidate, state.evidence, p, {
					rejectBodyRewrite: assembly.mode === "compact",
				});
				requireThat(
					bytes(
						request.delivery === "artifact"
							? renderSkillMarkdown(
									buildContent(p, candidate, state.evidence),
									undefined,
									ports.skillMarkdown,
								)
							: buildContent(p, candidate, state.evidence),
					) <= request.limits.outputBytes,
					"context_budget_exceeded",
				);
			} catch (error) {
				if (
					!(error instanceof SkillSmithError) ||
					error.code === "context_budget_exceeded"
				)
					throw error;
				lastFailure = error.code;
				repair = {
					code: error.code,
					instruction:
						"前回の出力は構造検査で拒否された（" +
						error.code +
						"）。元の目的・制約を保ちschemaに従い、この違反を解消して返す。",
				};
				continue;
			}
		}
		decision = candidate;
		break;
	}
	checkpoint();
	requireThat(decision, lastFailure);
	if (decision.kind === "ready" && assembly.mode !== "legacy") {
		const reason = z.string().min(1).max(2000);
		const correction = z
			.strictObject({
				localizedInstructions:
					skillPresentationSchema.shape.localizedInstructions,
				document: lean ? leanDocumentSchema : skillDocumentSchema,
			})
			.optional();
		const reviewSchema = lean
			? z.discriminatedUnion("approved", [
					z.strictObject({
						approved: z.literal(true),
						reason,
						sourceReview: sourceReviewSchema,
						nonSourceAdditions: nonSourceAdditionsSchema,
					}),
					z.strictObject({ approved: z.literal(false), reason, correction }),
				])
			: z
					.strictObject({ approved: z.boolean(), reason, correction })
					.refine(
						(r) => !r.approved || !r.correction,
						"approved_correction_conflict",
					);
		let reviewed = decision;
		for (let reviewRound = 0; reviewRound < 2; reviewRound++) {
			const artifact = renderSkillMarkdown(
				buildContent(p, reviewed, state.evidence),
			);
			const {
				localizedInstructions: _instructions,
				document,
				...auditDecision
			} = reviewed;
			const input = {
				system: lean ? leanReviewInstructions : semanticReviewInstructions,
				data: {
					originalTask: request.task,
					reviewPlan: [
						{ phase: "canonical-faithfulness" },
						{
							phase: "post-build-self-review",
							weights: {
								correctness: 35,
								actionability: 25,
								coverage: 20,
								concision: 10,
								format: 10,
							},
						},
					],
					untrustedReview: spotlightUntrusted([
						{
							ref: "review",
							decision: lean
								? {
										...auditDecision,
										provisionalNotice: document?.provisionalNotice,
									}
								: reviewed,
							sources: state.evidence.filter((e) =>
								reviewed.sourceRefs.includes(e.ref),
							),
							artifact: artifact.content,
							files: artifact.files ?? [],
						},
					]),
				},
				schema: z.toJSONSchema(reviewSchema),
				deadlineAt: request.limits.deadlineAt,
				maxOutputTokens: request.limits.outputTokens,
				requestRef: r.ref,
			};
			requireThat(
				bytes(input) <= request.limits.inputBytes,
				"context_budget_exceeded",
			);
			const answer = await complete(input, "semantic-review");
			receipt = answer.receipt;

			const result = reviewSchema.safeParse(answer.value);
			requireThat(result.success, "semantic_review_failed");
			if (result.data.approved) {
				decision =
					"sourceReview" in result.data
						? {
								...reviewed,
								sourceReview: result.data.sourceReview,
								nonSourceAdditions: result.data.nonSourceAdditions,
							}
						: reviewed;
				break;
			}
			requireThat(
				reviewRound === 0 && result.data.correction,
				"semantic_review_failed",
			);
			reviewed = { ...reviewed, ...result.data.correction };
			checkLocalizedHost(request.task, reviewed);
			checkDecision(reviewed, state.evidence, p, {
				rejectBodyRewrite: assembly.mode === "compact",
			});
			requireThat(
				bytes(
					request.delivery === "artifact"
						? renderSkillMarkdown(
								buildContent(p, reviewed, state.evidence),
								undefined,
								ports.skillMarkdown,
							)
						: buildContent(p, reviewed, state.evidence),
				) <= request.limits.outputBytes,
				"context_budget_exceeded",
			);
		}
	}
	if (decision.kind === "ready") {
		const selected = state.evidence.filter(
			(e) => decision.sourceRefs.includes(e.ref) && e.external,
		);
		if (selected.length)
			requireThat(
				ports.source &&
					(await sourceCall(() =>
						ports.source!.validate(
							selected,
							signal,
							metered ? sourceContext : undefined,
						),
					)),
				"source_revoked",
			);
	}
	checkpoint();
	const total = reportedUsage();
	return {
		decision,
		evidence: state.evidence,
		receipt,
		tokens: {
			input: total.inputTokens,
			output: total.outputTokens,
			reasoningTokens: total.reasoningTokens,
			cachedInputTokens: total.cachedInputTokens,
		},
	};
}

export function failureCode(error: unknown) {
	if (error instanceof SkillSmithError) return error.code;
	return "build_failed";
}
export const contentDigest = (content: Build["content"]) => digest(content);
