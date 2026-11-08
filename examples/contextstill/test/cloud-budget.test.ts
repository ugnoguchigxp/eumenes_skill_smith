import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudBudget } from "../cloud-budget.js";

test("output truncation retains its cause and reasoning usage without accepting partial JSON", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cloud-truncation-"));
	try {
		const incomplete: { outputText: string; reason: string | null }[] = [];
		const budget = createCloudBudget({
			onIncomplete: (event) => incomplete.push(event),
			baseUrl: "https://fixture.invalid/v1",
			credential: "fixture",
			maxUsd: 10,
			journal: join(dir, "ledger.jsonl"),
			fetch: async () =>
				Response.json({
					id: "truncated",
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
					usage: {
						input_tokens: 10,
						output_tokens: 100,
						output_tokens_details: { reasoning_tokens: 30 },
					},
					output: [
						{
							type: "message",
							content: [{ type: "output_text", text: '{"result":' }],
						},
					],
				}),
		});
		await expect(
			budget.complete(
				{ id: "fixture-model", inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
				"build",
				{
					system: "Return JSON",
					data: {},
					schema: {},
					deadlineAt: 1,
					maxOutputTokens: 100,
					requestRef: "request",
				},
				new AbortController().signal,
			),
		).rejects.toThrow("cloud_output_limit");
		expect(budget.events()[0]).toMatchObject({
			responseStatus: "incomplete",
			incompleteReason: "max_output_tokens",
			reasoningTokens: 30,
			inputTokens: 10,
			outputTokens: 100,
		});
		expect(budget.spent()).toBeCloseTo(0.00011);
		expect(incomplete).toMatchObject([
			{ outputText: '{"result":', reason: "max_output_tokens" },
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

for (const failure of ["oversize", "missing-receipt"] as const) {
	test(
		"cloud response boundary rejects " +
			failure +
			" without a valid inference result",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "cloud-response-"));
			try {
				let cancelled = false;
				const budget = createCloudBudget({
					baseUrl: "https://fixture.invalid/v1",
					credential: "fixture",
					maxUsd: 10,
					journal: join(dir, "ledger.jsonl"),
					fetch: async () =>
						failure === "oversize"
							? new Response(
									new ReadableStream({
										start(controller) {
											controller.enqueue(new Uint8Array(2 * 1024 * 1024));
											controller.enqueue(new Uint8Array(1));
										},
										cancel() {
											cancelled = true;
										},
									}),
								)
							: Response.json({
									status: "completed",
									usage: { input_tokens: 1, output_tokens: 1 },
									output: [
										{
											type: "message",
											content: [
												{ type: "output_text", text: '{"result":{"ok":true}}' },
											],
										},
									],
								}),
				});
				await expect(
					budget.complete(
						{
							id: "fixture-model",
							inputUsdPerMillion: 1,
							outputUsdPerMillion: 1,
						},
						"build",
						{
							system: "Return JSON",
							data: {},
							schema: {},
							deadlineAt: 1,
							maxOutputTokens: 100,
							requestRef: "request",
						},
						new AbortController().signal,
					),
				).rejects.toThrow(
					failure === "oversize"
						? "cloud_response_too_large"
						: "cloud_receipt_missing",
				);
				expect(budget.spent()).toBeGreaterThan(0);
				if (failure === "oversize") expect(cancelled).toBe(true);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
}

test("concurrent calls wait for committed cost settlement instead of exceeding the cap", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cloud-queue-"));
	try {
		let calls = 0,
			release: () => void = () => {};
		const budget = createCloudBudget({
			baseUrl: "https://fixture.invalid/v1",
			credential: "fixture",
			maxUsd: 0.06,
			journal: join(dir, "ledger.jsonl"),
			fetch: async () => {
				const n = ++calls;
				if (n === 1)
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				return Response.json({
					id: "r" + n,
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1 },
					output: [
						{
							type: "message",
							content: [
								{ type: "output_text", text: '{"result":{"ok":true}}' },
							],
						},
					],
				});
			},
		});
		const model = {
			id: "fixture-model",
			inputUsdPerMillion: 1,
			outputUsdPerMillion: 1,
		};
		const input = {
			system: "Return JSON",
			data: {},
			schema: {
				type: "object",
				properties: { ok: { type: "boolean" } },
				required: ["ok"],
				additionalProperties: false,
			},
			deadlineAt: 1,
			maxOutputTokens: 100,
			requestRef: "request",
		};
		const first = budget.complete(
			model,
			"build",
			input,
			new AbortController().signal,
		);
		await Promise.resolve();
		const second = budget.complete(
			model,
			"build",
			input,
			new AbortController().signal,
		);
		await Promise.resolve();
		expect(calls).toBe(1);
		release();
		await Promise.all([first, second]);
		expect(calls).toBe(2);
		expect(budget.spent()).toBe(0.000004);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
test("cancelling a cost waiter causes no second physical call", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cloud-wait-cancel-"));
	try {
		let calls = 0,
			release: () => void = () => {};
		const budget = createCloudBudget({
			baseUrl: "https://fixture.invalid/v1",
			credential: "fixture",
			maxUsd: 0.06,
			journal: join(dir, "ledger.jsonl"),
			fetch: async () => {
				calls++;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return new Response("failure", { status: 503 });
			},
		});
		const model = {
				id: "fixture-model",
				inputUsdPerMillion: 1,
				outputUsdPerMillion: 1,
			},
			input = {
				system: "Return JSON",
				data: {},
				schema: {},
				deadlineAt: 1,
				maxOutputTokens: 100,
				requestRef: "request",
			};
		const first = budget.complete(
			model,
			"build",
			input,
			new AbortController().signal,
		);
		await Promise.resolve();
		const controller = new AbortController(),
			second = budget.complete(model, "build", input, controller.signal);
		controller.abort(new Error("cancel_wait"));
		await expect(second).rejects.toThrow("cancel_wait");
		expect(calls).toBe(1);
		release();
		await expect(first).rejects.toThrow("cloud_http_503");
		expect(budget.events()).toHaveLength(1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cloud budget reserves unknown failures across restarts and prevents any next physical call", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cloud-budget-"));
	try {
		let calls = 0;
		const options = {
			baseUrl: "https://fixture.invalid/v1",
			credential: "fixture",
			maxUsd: 0.06,
			journal: join(dir, "ledger.jsonl"),
			fetch: async () => {
				calls++;
				return new Response("failure", { status: 503 });
			},
		};
		const model = {
			id: "fixture-model",
			inputUsdPerMillion: 1,
			outputUsdPerMillion: 1,
		};
		const input = {
			system: "Return JSON",
			data: {},
			schema: {},
			deadlineAt: 1,
			maxOutputTokens: 100,
			requestRef: "request",
		};
		const first = createCloudBudget(options);
		await expect(
			first.complete(model, "build", input, new AbortController().signal),
		).rejects.toThrow("cloud_http_503");
		expect(first.spent()).toBeGreaterThan(0);
		const restarted = createCloudBudget(options);
		expect(restarted.spent()).toBe(first.spent());
		await expect(
			restarted.complete(model, "build", input, new AbortController().signal),
		).rejects.toThrow("cloud_cost_limit");
		expect(calls).toBe(1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
test("cloud budget records paid usage even when structured output is incomplete", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cloud-budget-"));
	try {
		const budget = createCloudBudget({
			baseUrl: "https://fixture.invalid/v1",
			credential: "fixture",
			maxUsd: 10,
			journal: join(dir, "ledger.jsonl"),
			fetch: async () =>
				Response.json({
					id: "response",
					status: "incomplete",
					usage: { input_tokens: 50, output_tokens: 100 },
				}),
		});
		await expect(
			budget.complete(
				{ id: "fixture-model", inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
				"build",
				{
					system: "Return JSON",
					data: {},
					schema: {},
					deadlineAt: 1,
					maxOutputTokens: 100,
					requestRef: "request",
				},
				new AbortController().signal,
			),
		).rejects.toThrow("cloud_incomplete");
		expect(budget.spent()).toBe(0.00025);
		expect(budget.events()).toHaveLength(1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
