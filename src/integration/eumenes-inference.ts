import type { Ports } from "../contracts/ports.js";
import { digest, requireThat } from "../service/identity.js";
import {
	decodeProviderValue,
	strictProviderSchema,
	strictSchemaInstructions,
} from "./provider-schema.js";

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
			structuredOutput?: true;
		},
	): string;
	executeControl(
		id: string,
		messages: { role: "system" | "user"; content: string }[],
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
	/** Enable only when the host route supports strict provider schemas. */
	structuredOutput?: boolean;
}): Ports<Tx>["inference"] {
	const { control, read, write, structuredOutput } = options;
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
					...(structuredOutput ? { structuredOutput: true as const } : {}),
				});
			});
			signal.throwIfAborted();
			const instructions = structuredOutput
				? input.system + "\n" + strictSchemaInstructions
				: input.system;
			const answer = await control.executeControl(
				id,
				[
					{ role: "system", content: instructions },
					{ role: "user", content: JSON.stringify(input.data) },
				],
				signal,
				{
					instructions,
					outputSchema: structuredOutput
						? strictProviderSchema(input.schema)
						: input.schema,
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
				const decoded = JSON.parse(answer.value);
				value = structuredOutput
					? decodeProviderValue(decoded?.result, input.schema)
					: decoded;
			} catch {
				// The runtime still rejects this value against its schema. Preserve
				// the completed receipt and its usage so rejection is metered.
				value = undefined;
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
