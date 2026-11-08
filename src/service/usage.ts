import type { ObservedUsage } from "../contracts/ports.js";

type TokenObservation = Pick<
	ObservedUsage,
	"inputTokens" | "outputTokens" | "reasoningTokens" | "cachedInputTokens"
>;

/** Provider observations only. Omission is distinct from an explicit unknown. */
export function createUsageTotals() {
	const total = {
		inputTokens: 0 as number | null,
		outputTokens: 0 as number | null,
		reasoningTokens: null as number | null,
		cachedInputTokens: null as number | null,
	};
	const reported = new Set<keyof TokenObservation>([
		"inputTokens",
		"outputTokens",
	]);
	return {
		add(observation: TokenObservation) {
			for (const key of [
				"inputTokens",
				"outputTokens",
				"reasoningTokens",
				"cachedInputTokens",
			] as const) {
				const value = observation[key];
				if (value === undefined) continue;
				total[key] = !reported.has(key)
					? value
					: total[key] === null || value === null
						? null
						: total[key] + value;
				reported.add(key);
			}
		},
		snapshot: () => ({ ...total }),
	};
}
