import { test, expect } from "bun:test";
import type { CallObservation } from "../../../src/contracts/ports.js";
import { sourceOperation } from "../source-budget.js";
import { createFixtureSource } from "../source.js";
import { setup, handle } from "./fixture.js";

for (const metered of [false, true])
	test(
		"source observer failure emits one physical observation (metered=" +
			metered +
			")",
		async () => {
			const f = setup(),
				calls: CallObservation[] = [];
			let reservations = 0;
			const signal = new AbortController().signal;
			const context = {
				signal,
				reserve: async () => {
					reservations++;
				},
				noteCall: (call: CallObservation) => {
					calls.push(call);
					throw Error("observer_failed");
				},
			};
			const ref = "contextstill:" + handle("a");
			const result = metered
				? f.source.get(ref, signal, context)
				: sourceOperation(
						{ ...f.source, meteredCalls: false },
						context,
						"get",
						() => f.source.get(ref, signal),
					);
			await expect(result).rejects.toThrow("observer_failed");
			expect(reservations).toBe(1);
			expect(calls).toHaveLength(1);
			expect(calls[0]!.outcome).toBe("ok");
		},
	);
test("malformed RPC content produces one error observation and no success", async () => {
	const source = createFixtureSource(async (request) => {
		const input = await request.json();
		return Response.json({
			jsonrpc: "2.0",
			id: input.id,
			result: { content: [{ type: "text", text: "{bad" }] },
		});
	}, "fixture");
	const signal = new AbortController().signal,
		calls: CallObservation[] = [];
	await expect(
		source.get("contextstill:" + handle("a"), signal, {
			signal,
			reserve: async () => {},
			noteCall: (call) => calls.push(call),
		}),
	).rejects.toThrow();
	expect(calls).toHaveLength(1);
	expect(calls[0]!.outcome).toBe("error");
});
