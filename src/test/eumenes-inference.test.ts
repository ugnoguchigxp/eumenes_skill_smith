import { expect, test } from "bun:test";
import { z } from "zod";
import { createEumenesInference, type EumenesControl } from "../index.js";

test("host uses the same strict envelope and meters completed malformed output", async () => {
	let subject: string;
	let structuredOutput: true | undefined;
	let sent: unknown;
	let value = '{"result":{"action":"keep","note":null}}';
	const control: EumenesControl<null> = {
		captureUserControlInTransaction(_tx, input) {
			subject = input.subject;
			structuredOutput = input.structuredOutput;
			return "request";
		},
		async executeControl(requestId, _messages, _signal, contract) {
			sent = contract.outputSchema;
			return { requestId, attemptId: "attempt", value };
		},
		validateReceiptInTransaction: () => true,
		usageOfInTransaction: () => ({
			subject,
			inputTokens: 21,
			outputTokens: 7,
			cacheReadTokens: 0,
		}),
	};
	const port = createEumenesInference({
		control,
		read: (op) => op(null),
		write: async (op) => op(null),
		structuredOutput: true,
	});
	const schema = z.strictObject({
		action: z.literal("keep"),
		note: z.string().optional(),
	});
	const input = {
		requestRef: "selected",
		deadlineAt: Date.now() + 120000,
		maxOutputTokens: 256,
		system: "fixture",
		data: {},
		schema: z.toJSONSchema(schema),
	};
	const signal = new AbortController().signal;
	const ready = await port.complete(input, signal);
	expect(structuredOutput).toBe(true);
	expect(sent).toMatchObject({
		type: "object",
		required: ["result"],
		properties: { result: { required: ["action", "note"] } },
	});
	expect(schema.parse(ready.value)).toEqual({ action: "keep" });
	expect(port.validReceipt(null, ready.receipt, input.requestRef)).toBe(true);
	expect(port.validReceipt(null, ready.receipt, "other")).toBe(false);
	value = '{"result":';
	const invalid = await port.complete(input, signal);
	expect(schema.safeParse(invalid.value).success).toBe(false);
	expect(invalid).toMatchObject({
		inputTokens: 21,
		outputTokens: 7,
		cachedInputTokens: 0,
	});
});
