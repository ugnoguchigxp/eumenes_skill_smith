import { expect, test } from "bun:test";
import { aggregateUsageLedger } from "../eval/index.js";
import { fixture } from "./fixture.js";
import { sqliteRepository } from "../sqlite/index.js";

test("failed multi-call build retains observed tokens via noteUsage", async () => {
	const f = fixture();
	f.setOutput({ kind: "not-a-turn" });
	const pending = f.submit();
	await expect(f.run(pending.requestRef!)).rejects.toThrow(
		"invalid_model_output",
	);
	const usage = sqliteRepository.request(f.db, pending.requestRef!)!.usage;
	expect(usage.modelCalls).toBe(2);
	// Fixture inference returns 20/30 per call; both attempts observed before throw.
	expect(usage.inputTokens).toBe(40);
	expect(usage.outputTokens).toBe(60);
	expect(usage.reasoningTokens).toBeNull();
	expect(usage.cachedInputTokens).toBeNull();
});

test("reasoning metadata stays null when provider omits it", async () => {
	const f = fixture();
	const pending = f.submit();
	const work = await f.run(pending.requestRef!);
	expect(work.settle()).toBe(true);
	const usage = sqliteRepository.request(f.db, pending.requestRef!)!.usage;
	expect(usage.inputTokens).toBe(20);
	expect(usage.outputTokens).toBe(30);
	expect(usage.reasoningTokens).toBeNull();
	expect(usage.cachedInputTokens).toBeNull();
});

test("provider reasoning tokens accumulate without inventing when one call omits", async () => {
	const f = fixture();
	let n = 0;
	f.ports.inference.complete = async () => {
		n++;
		return {
			value: structuredClone(
				n === 1
					? { kind: "not-a-turn" }
					: {
							kind: "needs_input",
							missing: ["不足"],
						},
			),
			receipt: "receipt",
			inputTokens: 2,
			outputTokens: 3,
			reasoningTokens: n === 1 ? 5 : undefined,
		};
	};
	f.request.limits.modelCalls = 2;
	const pending = f.submit();
	const work = await f.run(pending.requestRef!);
	expect(work.settle()).toBe(true);
	const usage = sqliteRepository.request(f.db, pending.requestRef!)!.usage;
	// Second call omitted reasoningTokens → keep first observed 5 (not invent 0).
	expect(usage.reasoningTokens).toBe(5);
	expect(usage.inputTokens).toBe(4);
	expect(usage.outputTokens).toBe(6);
});

test("aggregateUsageLedger does not double-count included reasoning", () => {
	const ledger = aggregateUsageLedger([
		{
			callKind: "build",
			inputTokens: 10,
			outputTokens: 20,
			reasoningTokens: 4,
			cachedInputTokens: null,
			reasoningIncludedInOutput: true,
			outcome: "ok",
		},
		{
			callKind: "build",
			inputTokens: 5,
			outputTokens: 7,
			reasoningTokens: 3,
			cachedInputTokens: 1,
			reasoningIncludedInOutput: false,
			outcome: "invalid_output",
		},
	]);
	expect(ledger.totals.inputTokens).toBe(15);
	expect(ledger.totals.outputTokens).toBe(27);
	expect(ledger.totals.reasoningTokens).toBe(7);
	// Only the second call's reasoning is added on top of output.
	expect(ledger.totals.billableOutputTokens).toBe(30);
	expect(ledger.totals.cachedInputTokens).toBeNull();
});

test("aggregateUsageLedger keeps null when any call is unknown", () => {
	const ledger = aggregateUsageLedger([
		{
			callKind: "reflection",
			inputTokens: 1,
			outputTokens: null,
			reasoningTokens: null,
			cachedInputTokens: null,
			reasoningIncludedInOutput: false,
			outcome: "ok",
		},
	]);
	expect(ledger.totals.inputTokens).toBe(1);
	expect(ledger.totals.outputTokens).toBeNull();
	expect(ledger.totals.reasoningTokens).toBeNull();
});

test("M4 billing completeness matrix: separate unknown, included unknown, mixed known and absent", () => {
	const call = (
		outputTokens: number | null,
		reasoningTokens: number | null,
		reasoningIncludedInOutput: boolean,
	) => ({
		callKind: "build" as const,
		inputTokens: 1,
		outputTokens,
		reasoningTokens,
		reasoningIncludedInOutput,
		outcome: "ok" as const,
	});
	for (const [calls, total, observed] of [
		[[call(20, null, false)], null, 20],
		[[call(20, null, true)], 20, 20],
		[[call(20, null, false), call(5, 7, false)], null, 32],
		[[call(20, null, true), call(5, 7, false)], 32, 32],
		[[call(null, 7, false)], null, 7],
		[[call(20, 7, true)], 20, 20],
		[[], 0, 0],
	] as const) {
		const ledger = aggregateUsageLedger([...calls]);
		expect(ledger.totals.billableOutputTokens).toBe(total);
		expect(ledger.totals.observedBillableOutputTokens).toBe(observed);
	}
});
