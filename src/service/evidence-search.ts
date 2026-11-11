import type { z } from "zod";
import type { Ports, ExecutionContext } from "../contracts/ports.js";
import type { Evidence, EvidenceCard, Prepared } from "../contracts/types.js";
import { evidenceSchema, sourceSearchSchema } from "../contracts/schema.js";
import { digest, requireThat, SkillSmithError } from "./identity.js";

type Call = <T>(operation: () => Promise<T>) => Promise<T>;
function parseEvidence(raw: unknown): Evidence {
	const parsed = evidenceSchema.safeParse(raw);
	requireThat(parsed.success, "source_contract_violation");
	return parsed.data;
}

type SearchState = {
	candidates: EvidenceCard[];
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

function matchesCard(
	document: Evidence,
	card: SearchState["candidates"][number],
) {
	return (
		document.ref === card.ref &&
		document.status === card.status &&
		document.external === card.external &&
		document.scope === card.scope &&
		(card.revisionOnly
			? document.version.id === card.version.id &&
				document.version.version === card.version.version &&
				document.version.generation === card.version.generation
			: digest(document.version) === digest(card.version) &&
				document.complete === card.complete &&
				document.supersededBy === card.supersededBy)
	);
}

/** Search/refresh evidence under the caller's existing execution budget. */
export function createEvidenceSearch<Tx>(
	ports: Ports<Tx>,
	p: Prepared,
	io: {
		call: Call;
		sourceCall: Call;
		checkpoint(): void;
		reserve: ExecutionContext["reserve"];
		sourceContext: ExecutionContext;
		metered: boolean | undefined;
	},
) {
	const { call, sourceCall, checkpoint, reserve, sourceContext, metered } = io;
	const { signal } = sourceContext;
	const r = p.record,
		request = r.request;
	const read = (ref: string, external: boolean) =>
		external
			? (requireThat(ports.source, "source_unavailable"),
				ports.source.get(ref, signal, metered ? sourceContext : undefined))
			: ports.registry.read(ref, r.authority, signal);
	async function readCard(card: SearchState["candidates"][number]) {
		const document = parseEvidence(
			await (card.external ? sourceCall : call)(() =>
				read(card.ref, card.external),
			),
		);
		requireThat(matchesCard(document, card), "source_revoked");
		document.retrievedAt = ports.now();
		return document;
	}
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
		// The model can refine the registry query. The authorized public query
		// is immutable for the duration of this execution.
		const externalQuery =
			state && ports.assemblyMode !== "legacy" ? undefined : queryExternal;
		const reported =
			externalUsed && externalQuery
				? sourceSearchSchema.safeParse(
						await sourceCall(() =>
							ports.source!.search(
								externalQuery,
								request.limits.candidates,
								signal,
								metered ? sourceContext : undefined,
							),
						),
					)
				: null;
		requireThat(!reported || reported.success, "source_contract_violation");
		const sourceSearch = reported?.data ?? state?.sourceSearch;
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
		const cardsByRef = new Map(candidates.map((card) => [card.ref, card]));
		let evidence = (state?.evidence ?? []).filter((e) => {
			const card = cardsByRef.get(e.ref);
			return card && matchesCard(e, card);
		});
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
			// Modern external cards are already sufficient for the model to request disclosure.
			// Keep legacy replay and successor discovery eager, without spending reads on unused active cards.
			if (
				card.status === "active" &&
				(ports.assemblyMode === "lean" ||
					(ports.assemblyMode !== "legacy" && card.external))
			)
				continue;
			if (evidence.length >= request.limits.documents) {
				// Evict a prior-only document to admit a new-round card.
				if (!state || !newRoundRefs.has(card.ref)) continue;
				const evictAt = evidence.findIndex((e) => !newRoundRefs.has(e.ref));
				if (evictAt < 0) continue;
				const evicted = evidence.splice(evictAt, 1)[0]!;
				seenEvidence.delete(evicted.ref);
			}
			const document = await readCard(card);
			evidence.push(document);
			seenEvidence.add(document.ref);
			documentsFetched++;
		}
		const retained = new Set(
			evidence.filter((e) => state?.evidence.includes(e)).map((e) => e.ref),
		);
		const successors =
			state?.successors.filter((s) => retained.has(s.ref)) ?? [];
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
			if (!e.external || !metered) await reserve("sourceCalls");
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
				externalQuery: externalQuery ?? null,
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
	return {
		search: runSearch,
		async disclose(state: SearchState, refs: string[]) {
			for (const ref of new Set(refs)) {
				checkpoint();
				if (state.evidence.some((e) => e.ref === ref)) continue;
				const card = state.candidates.find((c) => c.ref === ref);
				if (!card) continue;
				requireThat(
					state.evidence.length < request.limits.documents,
					"context_budget_exceeded",
				);
				state.evidence.push(await readCard(card));
			}
		},
	};
}
