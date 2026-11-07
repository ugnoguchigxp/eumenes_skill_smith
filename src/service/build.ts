import { z } from "zod";
import { renderSkillMarkdown, checkLocalizedHost } from "./skill-markdown.js";
import {
	semanticReviewInstructions,
	disclosureInstructions,
} from "../instructions/build.js";
import {
	CONTRACT,
	compactReadySchema,
	legacyModelTurnSchema,
	evidenceSchema,
	sourceSearchSchema,
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

function parseEvidence(raw: unknown): Evidence {
	const parsed = evidenceSchema.safeParse(raw);
	requireThat(parsed.success, "source_contract_violation");
	return parsed.data;
}

export function checkDecision(
	decision: ReadyDecision,
	evidence: Evidence[],
	p: Prepared,
	options?: { rejectBodyRewrite?: boolean },
) {
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
/** Host-appended acceptance/constraints/verification/assumptions blocks (shared with SKILL.md rendering). */
export function bodyTail(
	task: Build["content"]["task"],
	d: Pick<ReadyDecision, "verification" | "assumptions">,
): string[] {
	return [
		"受入条件\n" + task.acceptance.map((c) => c.id + ": " + c.text).join("\n"),
		task.constraints.length
			? "制約\n" + task.constraints.map((c) => c.id + ": " + c.text).join("\n")
			: "",
		"検証\n" + d.verification.join("\n"),
		d.assumptions.length
			? "前提\n" + d.assumptions.map((a) => a.text).join("\n")
			: "",
	].filter(Boolean);
}
export function buildContent(
	p: Prepared,
	d: ReadyDecision,
	evidence: Evidence[],
): Build["content"] {
	const selected = checkDecision(d, evidence, p);
	let body: string;
	if (d.localizedInstructions !== undefined) body = d.localizedInstructions;
	else if (d.strategy === "reuse") body = selected[0]!.body;
	else if (d.patches.length)
		body = selected[0]!
			.sections!.map((s) => {
				const patch = d.patches.find((x) => x.sectionId === s.id);
				return patch?.body ?? s.body;
			})
			.join("\n\n");
	else body = d.sections.map((s) => s.body).join("\n\n");
	const { request } = p.record;
	body = [
		!p.policy.alreadyPresent ? p.policy.body : "",
		body,
		...bodyTail(request.task, d),
	]
		.filter(Boolean)
		.join("\n\n");
	return {
		contractVersion: CONTRACT,
		task: request.task,
		audience: request.audience,
		environment: request.environment,
		body,
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
}

export async function executeBuild<Tx>(
	ports: Ports<Tx>,
	p: Prepared,
	context: ExecutionContext,
): Promise<Executed> {
	const r = p.record,
		request = r.request,
		{ signal, reserve, noteUsage } = context;
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
	const read = (ref: string, external: boolean) =>
		external
			? (requireThat(ports.source, "source_unavailable"),
				ports.source.get(ref, signal))
			: ports.registry.read(ref, r.authority, signal);

	type SearchState = {
		candidates: {
			ref: string;
			version: Evidence["version"];
			title: string;
			status: Evidence["status"];
			complete: boolean;
			external: boolean;
			scope: string;
			supersededBy?: string;
		}[];
		evidence: Evidence[];
		successors: {
			ref: string;
			successor: string;
			outcome: "fetched" | "unavailable" | "error" | "cycle" | "limit";
		}[];
		externalUsed: boolean;
		sourceSearch: z.infer<typeof sourceSearchSchema> | undefined;
		/** Warnings/degraded retained across re-search rounds for still-held refs. */
		sourceNotices:
			| {
					warnings: z.infer<typeof sourceSearchSchema>["warnings"];
					degraded: string[];
					truncated: boolean;
			  }
			| undefined;
		reSearch: {
			query: string;
			externalQuery: string | null;
			cardsAdded: number;
			cardsAdmitted: number;
			documentsFetched: number;
			round: number;
		}[];
	};

	async function runSearch(
		queryLocal: string,
		queryExternal: string | undefined,
		state: SearchState | null,
	): Promise<SearchState> {
		const local = await call(() =>
			ports.registry.search(
				queryLocal,
				r.authority,
				request.limits.candidates,
				signal,
			),
		);
		const externalUsed = !!(ports.source && r.authority.searchTask);
		const reported =
			externalUsed && queryExternal
				? sourceSearchSchema.safeParse(
						await call(() =>
							ports.source!.search(
								queryExternal,
								request.limits.candidates,
								signal,
							),
						),
					)
				: null;
		requireThat(!reported || reported.success, "source_contract_violation");
		const sourceSearch = reported?.data;
		const external = sourceSearch?.cards ?? [];
		requireThat(
			external.every((c) => c.external) &&
				(sourceSearch?.warnings ?? []).every((w) =>
					w.refs.every((ref) => external.some((c) => c.ref === ref)),
				),
			"source_contract_violation",
		);
		const combined: typeof local = [];
		const seenNew = new Set<string>();
		let cardsAdded = 0;
		for (let rank = 0; rank < Math.max(local.length, external.length); rank++) {
			for (const card of [local[rank], external[rank]]) {
				if (!card || seenNew.has(card.ref)) continue;
				seenNew.add(card.ref);
				combined.push(card);
				cardsAdded++;
			}
		}
		const prior = state?.candidates ?? [];
		const priorOnly = prior.filter((c) => !seenNew.has(c.ref));
		// Re-search prefers newly found cards in the bounded working set.
		const candidates = (
			state ? [...combined, ...priorOnly] : [...prior, ...combined]
		).slice(0, request.limits.candidates);
		const candidateRefs = new Set(candidates.map((c) => c.ref));
		const newRoundRefs = new Set(
			combined.map((c) => c.ref).filter((ref) => candidateRefs.has(ref)),
		);
		let evidence = (state?.evidence ?? []).filter((e) =>
			candidateRefs.has(e.ref),
		);
		// If documents are full, free slots by dropping prior-only evidence first.
		if (state && evidence.length >= request.limits.documents) {
			const keepNew = evidence.filter((e) => newRoundRefs.has(e.ref));
			const keepPrior = evidence.filter((e) => !newRoundRefs.has(e.ref));
			evidence = [...keepNew, ...keepPrior].slice(0, request.limits.documents);
			// Prefer room for at least one new document when new cards were admitted.
			if (
				newRoundRefs.size > 0 &&
				!evidence.some((e) => newRoundRefs.has(e.ref)) &&
				evidence.length >= request.limits.documents
			) {
				evidence = evidence.slice(0, Math.max(0, request.limits.documents - 1));
			}
		}
		const seenEvidence = new Set(evidence.map((e) => e.ref));
		let documentsFetched = 0;
		let cardsAdmitted = 0;
		for (const card of candidates) {
			if (!state || !state.candidates.some((c) => c.ref === card.ref))
				cardsAdmitted++;
			if (seenEvidence.has(card.ref)) continue;
			if (evidence.length >= request.limits.documents) {
				// Evict a prior-only document to admit a new-round card.
				if (!state || !newRoundRefs.has(card.ref)) continue;
				const evictAt = evidence.findIndex((e) => !newRoundRefs.has(e.ref));
				if (evictAt < 0) continue;
				const evicted = evidence.splice(evictAt, 1)[0]!;
				seenEvidence.delete(evicted.ref);
			}
			const document = parseEvidence(
				await call(() => read(card.ref, card.external)),
			);
			requireThat(
				document.ref === card.ref &&
					digest(document.version) === digest(card.version) &&
					document.external === card.external &&
					document.scope === card.scope,
				"source_revoked",
			);
			document.retrievedAt = ports.now();
			evidence.push(document);
			seenEvidence.add(document.ref);
			documentsFetched++;
		}
		const successors = state?.successors ? [...state.successors] : [];
		const seen = new Set(evidence.map((e) => e.ref));
		for (let i = 0; i < evidence.length; i++) {
			const e = evidence[i]!;
			if (e.status !== "superseded" || !e.supersededBy) continue;
			const successor = e.supersededBy;
			if (successors.some((s) => s.ref === e.ref && s.successor === successor))
				continue;
			if (seen.has(successor)) {
				successors.push({ ref: e.ref, successor, outcome: "cycle" });
				continue;
			}
			if (evidence.length >= request.limits.documents) {
				successors.push({ ref: e.ref, successor, outcome: "limit" });
				continue;
			}
			seen.add(successor);
			checkpoint();
			await reserve("sourceCalls");
			checkpoint();
			let next: Evidence | null = null;
			try {
				next = parseEvidence(await read(successor, e.external));
			} catch (error) {
				signal.throwIfAborted();
				if (error instanceof SkillSmithError) throw error;
				successors.push({ ref: e.ref, successor, outcome: "error" });
				continue;
			}
			if (
				next.ref === successor &&
				next.external === e.external &&
				(next.scope === "shared" || next.scope === r.authority.scope)
			) {
				next.retrievedAt = ports.now();
				evidence.push(next);
				successors.push({ ref: e.ref, successor, outcome: "fetched" });
			} else successors.push({ ref: e.ref, successor, outcome: "unavailable" });
		}
		const priorNotices = state?.sourceNotices;
		const mergedWarnings = [
			...(priorNotices?.warnings ?? []),
			...(sourceSearch?.warnings ?? []),
		];
		const warningKey = (w: { kind: string; refs: string[] }) =>
			w.kind + ":" + w.refs.slice().sort().join(",");
		const seenWarn = new Set<string>();
		const warnings = [];
		for (const w of mergedWarnings) {
			const key = warningKey(w);
			if (seenWarn.has(key)) continue;
			seenWarn.add(key);
			warnings.push(w);
		}
		const sourceNotices =
			sourceSearch || priorNotices
				? {
						warnings,
						degraded: [
							...new Set([
								...(priorNotices?.degraded ?? []),
								...(sourceSearch?.degraded ?? []),
							]),
						],
						truncated: !!(priorNotices?.truncated || sourceSearch?.truncated),
					}
				: undefined;
		const reSearch = state?.reSearch ? [...state.reSearch] : [];
		if (state)
			reSearch.push({
				query: queryLocal,
				externalQuery: queryExternal ?? null,
				cardsAdded,
				cardsAdmitted,
				documentsFetched,
				round: reSearch.length + 1,
			});
		return {
			candidates,
			evidence,
			successors,
			externalUsed,
			sourceSearch,
			sourceNotices,
			reSearch,
		};
	}

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
				external: e.external,
				scope: e.scope,
			})),
		).items;
		return {
			task: request.task,
			environment: request.environment,
			audience: request.audience,
			policy: p.policy,
			candidateCards,
			evidenceIndex:
				assembly.mode === "legacy"
					? evidence.map(evidenceCardView)
					: spotlightUntrusted(evidence.map(evidenceCardView)).items,
			untrustedEvidence: spotlightUntrusted(disclosed),
			disclosureProgress: {
				rounds: disclosureTrace.rounds,
				disclosedRefs: disclosureTrace.disclosedRefs,
				disclosedSectionIds: disclosureTrace.disclosedSectionIds,
				last: disclosureTrace.last,
				modelCallsLimit: request.limits.modelCalls,
				modelCallsUsed: modelCallsUsed,
			},
			freshness: evidence.map((e) => ({
				ref: e.ref,
				status: e.status,
				retrievedAt: e.retrievedAt ?? null,
				supersededBy: e.supersededBy ?? null,
				version: e.version,
			})),
			search: {
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
	const tokens = {
		input: 0 as number | null,
		output: 0 as number | null,
		reasoningTokens: null as number | null,
		cachedInputTokens: null as number | null,
	};
	let reasoningReported = false;
	let cachedReported = false;
	let repair: { code: string; instruction: string } | undefined;
	let lastFailure = "invalid_model_output";
	let reSearchUsed = false;
	const assembly = resolveAssembly(ports.assemblyMode ?? "baseline");
	let currentBuildTurn = assembly.mode !== "baseline";
	for (let attempt = 0; attempt < request.limits.modelCalls; attempt++) {
		checkpoint();
		modelCallsUsed = attempt + 1;
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
		await reserve("modelCalls");
		checkpoint();
		const answer = await ports.inference.complete(modelInput, signal);
		receipt = answer.receipt;
		tokens.input =
			tokens.input === null || answer.inputTokens === null
				? null
				: tokens.input + answer.inputTokens;
		tokens.output =
			tokens.output === null || answer.outputTokens === null
				? null
				: tokens.output + answer.outputTokens;
		if (answer.reasoningTokens !== undefined) {
			const reasoning = answer.reasoningTokens;
			if (!reasoningReported) {
				tokens.reasoningTokens = reasoning;
				reasoningReported = true;
			} else {
				tokens.reasoningTokens =
					tokens.reasoningTokens === null || reasoning === null
						? null
						: tokens.reasoningTokens + reasoning;
			}
		}
		if (answer.cachedInputTokens !== undefined) {
			const cached = answer.cachedInputTokens;
			if (!cachedReported) {
				tokens.cachedInputTokens = cached;
				cachedReported = true;
			} else {
				tokens.cachedInputTokens =
					tokens.cachedInputTokens === null || cached === null
						? null
						: tokens.cachedInputTokens + cached;
			}
		}
		if (noteUsage) {
			await noteUsage({
				inputTokens: tokens.input,
				outputTokens: tokens.output,
				reasoningTokens: tokens.reasoningTokens,
				cachedInputTokens: tokens.cachedInputTokens,
				receipt: answer.receipt,
				callKind: "build",
			});
		}
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
			state = await runSearch(turn.query, r.authority.searchTask, state);
			continue;
		}
		if (turn.kind === "disclose") {
			const unknownRefs = turn.items
				.map((i) => i.ref)
				.filter((ref) => !state.evidence.some((e) => e.ref === ref));
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
					bytes(buildContent(p, candidate, state.evidence)) <=
						request.limits.outputBytes,
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
		const reviewSchema = z.strictObject({
			approved: z.boolean(),
			reason: z.string().min(1).max(2000),
		});
		const artifact = renderSkillMarkdown(
			buildContent(p, decision, state.evidence),
		);
		const input = {
			system: semanticReviewInstructions,
			data: {
				originalTask: request.task,
				untrustedReview: spotlightUntrusted([
					{
						ref: "review",
						decision,
						sources: state.evidence.filter((e) =>
							decision.sourceRefs.includes(e.ref),
						),
						artifact: artifact.content,
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
		await reserve("modelCalls");
		checkpoint();
		const answer = await ports.inference.complete(input, signal);
		tokens.input =
			tokens.input === null || answer.inputTokens === null
				? null
				: tokens.input + answer.inputTokens;
		tokens.output =
			tokens.output === null || answer.outputTokens === null
				? null
				: tokens.output + answer.outputTokens;
		tokens.reasoningTokens =
			tokens.reasoningTokens === null || answer.reasoningTokens == null
				? null
				: tokens.reasoningTokens + answer.reasoningTokens;
		tokens.cachedInputTokens =
			tokens.cachedInputTokens === null || answer.cachedInputTokens == null
				? null
				: tokens.cachedInputTokens + answer.cachedInputTokens;
		receipt = answer.receipt;
		await noteUsage?.({
			inputTokens: tokens.input,
			outputTokens: tokens.output,
			reasoningTokens: tokens.reasoningTokens,
			cachedInputTokens: tokens.cachedInputTokens,
			receipt,
			callKind: "build",
		});
		const result = reviewSchema.safeParse(answer.value);
		requireThat(
			result.success && result.data.approved,
			"semantic_review_failed",
		);
	}
	if (decision.kind === "ready") {
		const selected = state.evidence.filter(
			(e) => decision.sourceRefs.includes(e.ref) && e.external,
		);
		if (selected.length)
			requireThat(
				ports.source &&
					(await call(() => ports.source!.validate(selected, signal))),
				"source_revoked",
			);
	}
	checkpoint();
	return { decision, evidence: state.evidence, receipt, tokens };
}

export function failureCode(error: unknown) {
	if (error instanceof SkillSmithError) return error.code;
	return "build_failed";
}
export const contentDigest = (content: Build["content"]) => digest(content);
