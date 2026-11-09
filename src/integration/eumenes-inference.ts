import type { Ports } from "../contracts/ports.js";
import { digest, requireThat } from "../service/identity.js";

type Receipt = {
	requestId: string;
	attemptId: string;
	value: string | Uint8Array;
};
type Usage = {
	subject: string;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
};

/** The public control and receipt operations of the Eumenes inference domain. */
export interface EumenesControl<Tx> {
	captureUserControlInTransaction(
		tx: Tx,
		input: {
			subject: string;
			deadline: number;
			maxOutputTokens: number;
			route: "subagent";
		},
	): string;
	executeControl(
		id: string,
		messages: { role: "user"; content: string }[],
		signal: AbortSignal,
		contract: { instructions: string; outputSchema: unknown },
	): Promise<Receipt & { toolCalls?: unknown[] }>;
	validateReceiptInTransaction(tx: Tx, receipt: Receipt): boolean;
	usageOfInTransaction(tx: Tx, receipt: Receipt): Usage | null;
}

/** The caller supplies the same host store as SkillSmith's queue and repository. */
export function createEumenesInference<Tx>(options: {
	control: EumenesControl<Tx>;
	read: <T>(operation: (tx: Tx) => T) => T;
	write: <T>(operation: (tx: Tx) => T) => Promise<T>;
}): Ports<Tx>["inference"] {
	const { control, read, write } = options;
	return {
		async complete(input, signal) {
			signal.throwIfAborted();
			const subject = "skillsmith:" + digest(input.requestRef);
			const id = await write((tx) => {
				signal.throwIfAborted();
				return control.captureUserControlInTransaction(tx, {
					subject,
					deadline: input.deadlineAt,
					maxOutputTokens: input.maxOutputTokens,
					route: "subagent",
				});
			});
			signal.throwIfAborted();
			const answer = await control.executeControl(
				id,
				[{ role: "user", content: JSON.stringify(input.data) }],
				signal,
				{
					instructions: input.system,
					outputSchema: input.schema,
				},
			);
			signal.throwIfAborted();
			requireThat(
				answer.requestId === id &&
					typeof answer.value === "string" &&
					!answer.toolCalls?.length,
				"host_inference_receipt_invalid",
			);
			const usage = read((tx) => control.usageOfInTransaction(tx, answer));
			let value: unknown;
			try {
				value = JSON.parse(answer.value);
			} catch {
				requireThat(false, "invalid_model_output");
			}
			return {
				value,
				receipt: JSON.stringify([answer.requestId, answer.attemptId]),
				inputTokens: usage?.inputTokens ?? null,
				outputTokens: usage?.outputTokens ?? null,
				cachedInputTokens: usage?.cacheReadTokens ?? null,
			};
		},
		validReceipt(tx, token, requestRef) {
			if (!requestRef) return false;
			let pair: unknown;
			try {
				pair = JSON.parse(token);
			} catch {
				return false;
			}
			if (
				!Array.isArray(pair) ||
				pair.length !== 2 ||
				typeof pair[0] !== "string" ||
				typeof pair[1] !== "string"
			)
				return false;
			const receipt = { requestId: pair[0], attemptId: pair[1], value: "" };
			return (
				control.usageOfInTransaction(tx, receipt)?.subject ===
					"skillsmith:" + digest(requestRef) &&
				control.validateReceiptInTransaction(tx, receipt)
			);
		},
	};
}
