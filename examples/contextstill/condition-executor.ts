/** Evaluation follows the delivery protocol: a question/error never silently becomes a no-skill execution. */
export type GenerationOutcome =
	| { kind: "ready" }
	| { kind: "needs_input"; missing: string[] }
	| { kind: "unavailable" | "rejected" | "error"; code: string };
type Answer = {
	kind: "ready" | "needs_input";
	answer: string;
	inputTokens: number | null;
	outputTokens: number | null;
};
export async function runGuidedExecutor(
	generation: GenerationOutcome,
	execute: () => Promise<Answer>,
) {
	if (generation.kind === "ready")
		return { ...(await execute()), executed: true };
	return {
		...generation,
		answer:
			generation.kind === "needs_input"
				? generation.missing.join("\n")
				: generation.code,
		inputTokens: 0,
		outputTokens: 0,
		executed: false,
	};
}
