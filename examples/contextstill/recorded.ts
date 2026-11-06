import type { Ports } from "../../src/index.js";
import { digest } from "../../src/index.js";

type Inference = Ports<unknown>["inference"];
type Input = Parameters<Inference["complete"]>[0];

/** Eval-only replay namespace, never part of the model data/system/schema. */
export type RecordContext = { evidenceSupply: "oracle" };

/** Exact model payload plus optional host-side replay context. Omitted preserves legacy digests. */
export const inferenceTask = (input: Input, recordContext?: RecordContext) => ({
	inputDigest: digest({
		system: input.system,
		data: input.data,
		schema: input.schema,
		...(recordContext ? { recordContext } : {}),
	}),
	...(recordContext ? { recordContext } : {}),
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
	recordContext?: RecordContext,
): Inference {
	const receipts = new Set<string>();
	return {
		complete: async (input, signal) => {
			signal.throwIfAborted();
			const task = inferenceTask(input, recordContext);
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
