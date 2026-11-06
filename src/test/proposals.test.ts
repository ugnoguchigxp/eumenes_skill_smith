import { expect, test } from "bun:test";
import { fixture, ready } from "./fixture.js";
test("reflection is conditional, reserved once, and persists only a candidate", async () => {
	const f = fixture(),
		r = await ready(f);
	f.service.bindUse(f.db, r.build.ref, "execution:1", f.auth, f.request);
	f.service.reportResult(
		f.db,
		{
			reportId: "report:1",
			buildRef: r.build.ref,
			executionRef: "execution:1",
			outcome: "succeeded",
			evidence: ["evidence:1"],
			summary: "確認した",
			improvement: "反例の確認が次回にも有用",
			expectedRevision: 0,
		},
		f.auth,
	);
	const prepared = f.write(() =>
		f.service.prepareReflection(f.db, "execution:1", f.auth),
	)!;
	f.setOutput({
		sections: [{ id: "verify", body: "結論に反する根拠も確認する。" }],
		conditions: ["複数の根拠がある"],
		evidence: ["evidence:1"],
	});
	const result = await f.service.propose(prepared, {
		signal: new AbortController().signal,
		reserve: async () => {
			f.write(() => f.service.reserveReflection(f.db, prepared, f.auth));
		},
	});
	const proposal = f.write(() =>
		f.service.saveProposal(f.db, prepared, result, f.auth),
	);
	expect(proposal?.status).toBe("proposed");
	expect(
		f.write(() => f.service.saveProposal(f.db, prepared, result, f.auth))?.ref,
	).toBe(proposal!.ref);
	expect(() =>
		f.write(() => f.service.reserveReflection(f.db, prepared, f.auth)),
	).toThrow("reflection_budget_exceeded");
	expect(f.modelCalls()).toBe(2);
	expect(() =>
		f.service.reviewProposal(f.db, proposal!.ref, 0, "validated", [], f.auth),
	).toThrow("verification_required");
	expect(
		f.service.reviewProposal(
			f.db,
			proposal!.ref,
			0,
			"validated",
			["test:receipt"],
			f.auth,
		).status,
	).toBe("validated");
});
test("a corrected report invalidates a reflection already in flight", async () => {
	const f = fixture(),
		r = await ready(f);
	f.service.bindUse(f.db, r.build.ref, "execution:1", f.auth, f.request);
	const report = {
		reportId: "report:1",
		buildRef: r.build.ref,
		executionRef: "execution:1",
		outcome: "failed",
		evidence: [],
		summary: "不足",
		improvement: "手順の前提を明記する",
		expectedRevision: 0,
	};
	f.service.reportResult(f.db, report, f.auth);
	const s = f.service.prepareReflection(f.db, "execution:1", f.auth)!;
	f.service.reserveReflection(f.db, s, f.auth);
	f.service.reportResult(
		f.db,
		{ ...report, reportId: "report:2", expectedRevision: 1 },
		f.auth,
	);
	expect(() =>
		f.service.saveProposal(
			f.db,
			s,
			{
				content: {
					sections: [{ id: "a", body: "案" }],
					conditions: ["条件"],
					evidence: [],
				},
				receipt: "receipt",
				inputTokens: 1,
				outputTokens: 1,
			},
			f.auth,
		),
	).toThrow("stale_result");
});
test("a report privilege change prevents consuming a reflection budget", async () => {
	const f = fixture(),
		r = await ready(f);
	f.service.bindUse(f.db, r.build.ref, "execution:1", f.auth, f.request);
	f.service.reportResult(
		f.db,
		{
			reportId: "r",
			buildRef: r.build.ref,
			executionRef: "execution:1",
			outcome: "failed",
			evidence: [],
			summary: "不足",
			improvement: "観測方法を改善する",
			expectedRevision: 0,
		},
		f.auth,
	);
	const s = f.service.prepareReflection(f.db, "execution:1", f.auth)!;
	expect(() =>
		f.service.reserveReflection(f.db, s, { ...f.auth, permissions: ["build"] }),
	).toThrow("permission_denied");
});
