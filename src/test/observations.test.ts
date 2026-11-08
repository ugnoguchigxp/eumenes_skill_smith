import { test, expect } from "bun:test";
import type { CallObservation } from "../contracts/ports.js";
import { fixture } from "./fixture.js";

for (const failure of ["none", "provider", "observer"] as const) {
	test(
		"physical model observation and durable usage with " + failure + " failure",
		async () => {
			const f = fixture();
			const pending = f.submit();
			const row = f.ports.repository.request(f.db, pending.requestRef!)!;
			const prepared = f.write(() =>
				f.service.prepare(f.db, row.ref, row.epoch, f.auth),
			)!;
			const calls: CallObservation[] = [];
			if (failure === "provider")
				f.ports.inference.complete = async () => {
					throw new Error("provider_failed");
				};
			const work = f.service.execute(prepared, {
				signal: new AbortController().signal,
				reserve: async (kind) => {
					f.write(() => f.service.reserve(f.db, prepared, kind, f.auth));
				},
				noteUsage: async (usage) => {
					f.write(() => f.service.noteUsage(f.db, prepared, f.auth, usage));
				},
				noteCall: (call) => {
					calls.push(call);
					if (failure === "observer") throw new Error("observer_failed");
				},
			});
			if (failure === "none") await work;
			else await expect(work).rejects.toThrow(failure + "_failed");
			expect(calls).toHaveLength(1);
			expect(calls[0]!.outcome).toBe(failure === "provider" ? "error" : "ok");
			expect(calls[0]!.durationMs).toBeGreaterThanOrEqual(0);
			expect(JSON.stringify(calls)).not.toContain("sections");
			expect(JSON.stringify(calls)).not.toContain("system");
			const usage = f.ports.repository.request(f.db, row.ref)!.usage;
			expect(usage.modelCalls).toBe(1);
			expect(usage.inputTokens).toBe(failure === "provider" ? null : 20);
			expect(usage.outputTokens).toBe(failure === "provider" ? null : 30);
			expect(usage.reasoningTokens).toBeNull();
		},
	);
}
