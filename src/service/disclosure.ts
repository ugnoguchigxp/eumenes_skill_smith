import type { Evidence, EvidenceCard, Section } from "../contracts/types.js";

/** Card view for progressive disclosure: metadata + section ids, no bodies. */
export function evidenceCardView(
	e: EvidenceCard & Pick<Partial<Evidence>, "sections" | "retrievedAt">,
): {
	ref: string;
	version: Evidence["version"];
	title: string;
	status: Evidence["status"];
	complete: boolean;
	external: boolean;
	scope: string;
	supersededBy?: string;
	sectionIds: string[];
	hasSections: boolean;
} {
	const sectionIds = e.sections?.map((s) => s.id) ?? [];
	return {
		ref: e.ref,
		version: e.version,
		title: e.title,
		status: e.status,
		complete: e.complete,
		external: e.external,
		scope: e.scope,
		...(e.supersededBy ? { supersededBy: e.supersededBy } : {}),
		...(e.retrievedAt !== undefined ? { retrievedAt: e.retrievedAt } : {}),
		sectionIds,
		hasSections: sectionIds.length > 0,
	};
}

/** Select bodies/sections the model requested. Empty sectionIds with hasSections=false → full body. */
export function discloseEvidence(
	evidence: Evidence[],
	requests: { ref: string; sectionIds?: string[] }[],
	includeBody = false,
): {
	ref: string;
	title: string;
	status: Evidence["status"];
	sections?: Section[];
	body?: string;
}[] {
	const out: {
		ref: string;
		title: string;
		status: Evidence["status"];
		sections?: Section[];
		body?: string;
	}[] = [];
	for (const req of requests) {
		const e = evidence.find((x) => x.ref === req.ref);
		if (!e) continue;
		if (e.sections?.length) {
			const ids = req.sectionIds?.length
				? req.sectionIds
				: e.sections.map((s) => s.id);
			const sections = e.sections.filter((s) => ids.includes(s.id));
			out.push({
				ref: e.ref,
				title: e.title,
				status: e.status,
				sections,
				...(includeBody ? { body: e.body } : {}),
			});
		} else {
			// No section IDs from source: full body fallback (proposal 05).
			out.push({
				ref: e.ref,
				title: e.title,
				status: e.status,
				body: e.body,
			});
		}
	}
	return out;
}

export function toSearchCards(evidence: Evidence[]): EvidenceCard[] {
	return evidence.map(({ body: _b, sections: _s, ...card }) =>
		structuredClone(card),
	);
}

/** Datamark untrusted disclosed material for the model (Spotlighting). Not a complete defense. */
export function spotlightUntrusted<T extends { ref: string }>(
	items: T[],
): { boundary: string; items: T[] } {
	return {
		boundary: "UNTRUSTED_EVIDENCE_BEGIN…UNTRUSTED_EVIDENCE_END",
		items: items.map((item) => ({
			...item,
			untrusted: true as const,
			datamark: "<<UNTRUSTED>>",
		})),
	};
}
