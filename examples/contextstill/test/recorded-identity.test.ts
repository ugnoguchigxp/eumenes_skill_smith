import { test, expect } from "bun:test";
import { inferenceTask, recordedInference } from "../recorded.js";
const input = {
	system: "fixed",
	data: { public: "task" },
	schema: { type: "object" },
	maxOutputTokens: 100,
	deadlineAt: 1000,
	requestRef: "r",
};
test("M5 semantic ID excludes transient routing but execution ID binds cap and provider settings", async () => {
	const a = inferenceTask(input),
		b = inferenceTask({ ...input, maxOutputTokens: 1 });
	expect(a.semanticInputId).toBe(b.semanticInputId);
	expect(a.executionConditionId).not.toBe(b.executionConditionId);
	expect(a.inputDigest).not.toBe(b.inputDigest);
	expect(
		inferenceTask({ ...input, deadlineAt: 2000, requestRef: "changed" })
			.inputDigest,
	).toBe(a.inputDigest);
	expect(
		inferenceTask(input, undefined, {
			providerSettings: {
				provider: "test",
				model: "v2",
				generation: { temperature: 0 },
			},
		}).executionConditionId,
	).not.toBe(a.executionConditionId);
	const model = recordedInference([
		{ inputDigest: a.inputDigest, provider: "test", value: { ok: true } },
	]);
	await expect(
		model.complete(
			{ ...input, maxOutputTokens: 1 },
			new AbortController().signal,
		),
	).rejects.toThrow("inference_record_missing");
});
test("M5 legacy records require explicit namespace; unknown usage remains null", async () => {
	const old = inferenceTask(input, undefined, { namespace: "legacy" });
	const records = [
		{ inputDigest: old.inputDigest, provider: "test", value: { ok: true } },
	];
	await expect(
		recordedInference(records).complete(input, new AbortController().signal),
	).rejects.toThrow("inference_record_missing");
	const answer = await recordedInference(records, undefined, undefined, {
		namespace: "legacy",
	}).complete(input, new AbortController().signal);
	expect(answer.value).toEqual({ ok: true });
	expect(answer.inputTokens).toBeNull();
	expect(answer.outputTokens).toBeNull();
});
