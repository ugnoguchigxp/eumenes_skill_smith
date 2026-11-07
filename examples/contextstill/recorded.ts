import type { Ports } from "../../src/index.js";
import { digest } from "../../src/index.js";

type Inference = Ports<unknown>["inference"];
type Input = Parameters<Inference["complete"]>[0];

/** Eval-only replay namespace, never part of the model data/system/schema. */
export type RecordContext = { evidenceSupply: "oracle" };

export interface ReplayOptions {
	namespace?: "legacy" | "execution.v2";
	providerSettings?: {
		provider: string | null;
		model: string | null;
		generation: Record<string, unknown> | null;
	};
}
/** Semantic identity is separate from generation conditions; transient routing is excluded. */
export const inferenceTask = (
	input: Input,
	recordContext?: RecordContext,
	options: ReplayOptions = {},
) => {
	const semanticInputId = digest({
		system: input.system,
		data: input.data,
		schema: input.schema,
		...(recordContext ? { recordContext } : {}),
	});
	const namespace = options.namespace ?? "execution.v2";
	const providerSettings = options.providerSettings ?? {
		provider: null,
		model: null,
		generation: null,
	};
	const executionConditionId =
		namespace === "legacy"
			? null
			: digest({ maxOutputTokens: input.maxOutputTokens, providerSettings });
	return {
		namespace,
		semanticInputId,
		executionConditionId,
		providerSettings,
		inputDigest:
			namespace === "legacy"
				? semanticInputId
				: digest({ namespace, semanticInputId, executionConditionId }),
		...(recordContext ? { recordContext } : {}),
		requestRef: input.requestRef,
		system: input.system,
		data: input.data,
		schema: input.schema,
		maxOutputTokens: input.maxOutputTokens,
		deadlineAt: input.deadlineAt,
	};
};
export type InferenceTask = ReturnType<typeof inferenceTask>;
export interface InferenceRecord {
	inputDigest: string;
	/** Structured output returned by the live provider; never authored by this module. */
	value: unknown;
	provider: string;
	namespace?: "legacy" | "execution.v2";
	semanticInputId?: string;
	executionConditionId?: string | null;
	providerSettings?: ReplayOptions["providerSettings"];
	inputTokens?: number | null;
	outputTokens?: number | null;
	reasoningTokens?: number | null;
	cachedInputTokens?: number | null;
}
/**
 * Replays pre-supplied provider outputs bound to the exact input digest.
 * Missing or mismatched records fail; this seam contains no meaning rules.
 */
export function recordedInference(
	records: InferenceRecord[],
	onTask: (task: InferenceTask) => void = () => {},
	recordContext?: RecordContext,
	options: ReplayOptions = {},
): Inference {
	const receipts = new Set<string>();
	return {
		complete: async (input, signal) => {
			signal.throwIfAborted();
			const task = inferenceTask(input, recordContext, options);
			onTask(task);
			const record = records.find((r) => r.inputDigest === task.inputDigest);
			if (!record) throw new Error("inference_record_missing");
			if (
				(record.namespace !== undefined &&
					record.namespace !== task.namespace) ||
				(record.semanticInputId !== undefined &&
					record.semanticInputId !== task.semanticInputId) ||
				(record.executionConditionId !== undefined &&
					record.executionConditionId !== task.executionConditionId) ||
				(record.providerSettings !== undefined &&
					digest(record.providerSettings) !== digest(task.providerSettings))
			)
				throw new Error("inference_record_identity_mismatch");
			const receipt = crypto.randomUUID();
			receipts.add(receipt);
			return {
				value: structuredClone(record.value),
				receipt,
				inputTokens: record.inputTokens ?? null,
				outputTokens: record.outputTokens ?? null,
				reasoningTokens: record.reasoningTokens ?? null,
				cachedInputTokens: record.cachedInputTokens ?? null,
			};
		},
		validReceipt: (_tx, receipt) => receipts.has(receipt),
	};
}
