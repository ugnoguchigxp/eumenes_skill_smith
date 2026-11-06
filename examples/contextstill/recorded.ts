import type { Ports } from "../../src/index.js";
import { digest } from "../../src/index.js";

type Inference = Ports<unknown>["inference"];
type Input = Parameters<Inference["complete"]>[0];

/** Exact payload a live provider (e.g. Grok Bot in the parent chat) must judge. */
export const inferenceTask = (input: Input) => ({
	inputDigest: digest({
		system: input.system,
		data: input.data,
		schema: input.schema,
	}),
	requestRef: input.requestRef,
	system: input.system,
	data: input.data,
	schema: input.schema,
	maxOutputTokens: input.maxOutputTokens,
	deadlineAt: input.deadlineAt,
});
export type InferenceTask = ReturnType<typeof inferenceTask>;
export interface InferenceRecord {
	inputDigest: string;
	/** Structured output returned by the live provider; never authored by this module. */
	value: unknown;
	provider: string;
}
/**
 * Replays pre-supplied provider outputs bound to the exact input digest.
 * Missing or mismatched records fail; this seam contains no meaning rules.
 */
export function recordedInference(
	records: InferenceRecord[],
	onTask: (task: InferenceTask) => void = () => {},
): Inference {
	const receipts = new Set<string>();
	return {
		complete: async (input, signal) => {
			signal.throwIfAborted();
			const task = inferenceTask(input);
			onTask(task);
			const record = records.find((r) => r.inputDigest === task.inputDigest);
			if (!record) throw new Error("inference_record_missing");
			const receipt = crypto.randomUUID();
			receipts.add(receipt);
			return {
				value: structuredClone(record.value),
				receipt,
				inputTokens: null,
				outputTokens: null,
			};
		},
		validReceipt: (_tx, receipt) => receipts.has(receipt),
	};
}
