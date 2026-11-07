import { test, expect } from "bun:test";
import { fixture, ready } from "./fixture.js";

for (const role of ["reflection", "workflow"] as const) {
	for (const phase of ["before", "reservation", "provider"] as const) {
		test(`${role} cancellation at ${phase} prevents a late candidate`, async () => {
			const f = fixture();
			const result = await ready(f);
			const execution = "cancelled-execution";
			f.service.bindUse(f.db, result.build.ref, execution, f.auth, f.request);
			f.service.reportResult(
				f.db,
				{
					reportId: "cancel-report",
					buildRef: result.build.ref,
					executionRef: execution,
					outcome: "failed",
					evidence: [],
					summary: "不足",
					improvement: "確認を改善する",
					expectedRevision: 0,
				},
				f.auth,
			);
			const controller = new AbortController();
			type Context = { signal: AbortSignal; reserve(): Promise<void> };
			let invoke: (context: Context) => Promise<unknown>;
			let reserveHost: () => void = () => {};
			let reflectionRef: string | null = null;
			if (role === "reflection") {
				const prepared = f.write(() =>
					f.service.prepareReflection(f.db, execution, f.auth),
				)!;
				reflectionRef = prepared.reflection.ref;
				reserveHost = () =>
					f.write(() => f.service.reserveReflection(f.db, prepared, f.auth));
				invoke = (context) => f.service.propose(prepared, context);
			} else {
				const prepared = f.write(() =>
					f.service.prepareWorkflow(
						f.db,
						{
							buildRef: result.build.ref,
							executionRef: execution,
							taskGoal: f.request.task.goal,
							succeededSummaries: ["過去の成功"],
							evidence: [],
						},
						f.auth,
					),
				);
				invoke = (context) => f.service.induceWorkflow(prepared, context);
			}
			let calls = 0,
				reservations = 0;
			f.ports.inference.complete = async () => {
				calls++;
				if (phase === "provider") controller.abort(new Error("stop"));
				return {
					value: {
						sections: [{ id: "check", body: "根拠を確認する。" }],
						conditions: ["比較する"],
						evidence: [],
					},
					receipt: "receipt",
					inputTokens: 1,
					outputTokens: 1,
				};
			};
			if (phase === "before") controller.abort(new Error("stop"));
			await expect(
				invoke({
					signal: controller.signal,
					reserve: async () => {
						reservations++;
						reserveHost();
						if (phase === "reservation") controller.abort(new Error("stop"));
					},
				}),
			).rejects.toThrow("stop");
			expect(reservations).toBe(phase === "before" ? 0 : 1);
			expect(calls).toBe(phase === "provider" ? 1 : 0);
			expect(
				f.ports.repository.proposalsByExecution(f.db, f.auth.scope, execution),
			).toEqual([]);
			if (reflectionRef)
				expect(
					f.ports.repository.reflection(f.db, reflectionRef)?.reserved,
				).toBe(phase !== "before");
		});
	}
}
