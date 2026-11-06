/**
 * Eval-only continuous provenance marking (closer to Spotlighting's interleaved marks).
 * Not the product default. JSON attribute labels ≠ this method; do not claim equivalence.
 */
export function continuousProvenanceMark(
	text: string,
	mark = "⟦U⟧",
): { marked: string; method: "continuous_provenance_v1"; note: string } {
	const chars = [...text];
	const marked = chars.map((ch, i) => (i % 8 === 7 ? ch + mark : ch)).join("");
	return {
		marked,
		method: "continuous_provenance_v1",
		note: "Eval-only. Not equivalent to product JSON attribute datamarks.",
	};
}

export function jsonAttributeMark<T extends { ref: string }>(items: T[]) {
	return {
		method: "json_attribute_datamark_v1" as const,
		note: "Matches product spotlightUntrusted shape; not continuous Spotlighting.",
		items: items.map((item) => ({
			...item,
			untrusted: true as const,
			datamark: "<<UNTRUSTED>>",
		})),
	};
}
