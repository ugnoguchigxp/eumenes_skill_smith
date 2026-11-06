import { z } from "zod";
import { workflowInstructions } from "../instructions/build.js";
export { workflowInstructions };

const id = z.string().min(1).max(160);
const text = z.string().trim().min(1).max(8000);

export const workflowCandidateSchema = z.strictObject({
	sections: z
		.array(z.strictObject({ id, body: text }))
		.min(1)
		.max(16),
	conditions: z.array(text).min(1).max(16),
	evidence: z.array(id).max(32),
});
export type WorkflowCandidate = z.infer<typeof workflowCandidateSchema>;

/** Induce a reusable workflow candidate via InferencePort. No keyword mining. */
export async function induceWorkflowCandidate(
	ports: {
		inference: {
			complete: (
				input: {
					system: string;
					data: unknown;
					schema: Record<string, unknown>;
					deadlineAt: number;
					maxOutputTokens: number;
					requestRef: string;
				},
				signal: AbortSignal,
			) => Promise<{
				value: unknown;
				inputTokens: number | null;
				outputTokens: number | null;
			}>;
		};
		now: () => number;
	},
	input: {
		taskGoal: string;
		succeededSummaries: string[];
		evidence: string[];
		requestRef: string;
		maxOutputTokens?: number;
	},
	signal: AbortSignal,
): Promise<WorkflowCandidate> {
	const response = await ports.inference.complete(
		{
			system: workflowInstructions,
			data: {
				taskGoal: input.taskGoal,
				succeededSummaries: input.succeededSummaries.slice(0, 16),
				evidence: input.evidence,
			},
			schema: z.toJSONSchema(workflowCandidateSchema),
			deadlineAt: ports.now() + 30_000,
			maxOutputTokens: input.maxOutputTokens ?? 1200,
			requestRef: input.requestRef,
		},
		signal,
	);
	return workflowCandidateSchema.parse(response.value);
}
