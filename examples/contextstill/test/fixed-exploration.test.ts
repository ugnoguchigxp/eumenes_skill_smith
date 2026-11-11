import { expect, test } from "bun:test";
import { createExampleHost } from "../host.js";
import { installFixedExploration } from "../fixed-exploration.js";

test("the pre-authored exploration bundle is delivered byte for byte after selection", async () => {
	let calls = 0;
	const host = createExampleHost(
		{
			search: async () => {
				throw Error("unexpected_search");
			},
			get: async () => {
				throw Error("unexpected_read");
			},
			validate: async () => {
				throw Error("unexpected_validation");
			},
		},
		"Plan bounded exploration",
		{
			validReceipt: (_tx, receipt) => receipt === "fixed-receipt",
			async complete({ data }) {
				calls++;
				const candidate = (data as { candidates: { ref: string }[] })
					.candidates[0]!;
				return {
					value:
						calls <= 2
							? {
									kind: "selected",
									ref: candidate.ref,
									assessment: "Safe to investigate.",
								}
							: { kind: "miss", reason: "Requires a verified procedure." },
					receipt: "fixed-receipt",
					inputTokens: 40,
					outputTokens: 20,
				};
			},
		},
		{ assemblyMode: "baseline" },
	);
	try {
		const { service, artifact } = installFixedExploration(host);
		for (const goal of [
			"Investigate a new file format",
			"Observe a new library",
		]) {
			const request = {
				...host.request,
				requestId: goal,
				delivery: "artifact" as const,
				task: { ...host.request.task, goal },
			};
			const prepared = service.prepareSkillSelection(
				host.db,
				request,
				host.authority,
			);
			const context = {
				signal: new AbortController().signal,
				reserve: async () => {},
			};
			const selected = await service.selectSkill(prepared, context);
			const bound = host.db.transaction(() =>
				service.bindSkillSelection(host.db, prepared, selected, host.authority),
			)();
			const reply = await service.getSkillDelivery(
				bound.requestRef!,
				host.authority,
				(op) => op(host.db),
				context.signal,
			);
			if (reply.kind !== "ready") throw Error("ready_required");
			expect(reply.skill).toEqual(artifact);
			expect(selected.usage).toMatchObject({
				modelCalls: 1,
				inputTokens: 40,
				outputTokens: 20,
			});
		}
		const prepared = service.prepareSkillSelection(
			host.db,
			host.request,
			host.authority,
		);
		const miss = await service.selectSkill(prepared, {
			signal: new AbortController().signal,
			reserve: async () => {},
		});
		expect(miss.decision.kind).toBe("miss");
		expect(() =>
			host.db.transaction(() =>
				service.bindSkillSelection(host.db, prepared, miss, host.authority),
			)(),
		).toThrow("selection_unavailable");
		expect(calls).toBe(3);
	} finally {
		host.close();
	}
});
