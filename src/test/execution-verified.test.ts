import { expect, test } from "bun:test";
import { fixture, ready } from "./fixture.js";

test("only succeeded bound executions can mark a proposal execution-verified", async () => {
	const f = fixture();
	const r = await ready(f);
	f.service.bindUse(f.db, r.build.ref, "execution:1", f.auth, f.request);
	f.service.reportResult(
		f.db,
		{
			reportId: "report:1",
			buildRef: r.build.ref,
			executionRef: "execution:1",
			outcome: "succeeded",
			evidence: ["evidence:1"],
			summary: "達成",
			improvement: "次回も使える",
			expectedRevision: 0,
		},
		f.auth,
	);
	const prepared = f.write(() =>
		f.service.prepareReflection(f.db, "execution:1", f.auth),
	)!;
	f.setOutput({
		sections: [{ id: "verify", body: "確認する。" }],
		conditions: ["成功報告あり"],
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
	)!;
	expect(proposal.executionVerified).toBeUndefined();
	const marked = f.service.markExecutionVerified(
		f.db,
		proposal.ref,
		proposal.revision,
		f.auth,
	);
	expect(marked.executionVerified).toBe(true);
	expect(marked.status).toBe("proposed");
});

test("failed reports cannot mark execution-verified", async () => {
	const f = fixture();
	const r = await ready(f);
	f.service.bindUse(f.db, r.build.ref, "execution:1", f.auth, f.request);
	f.service.reportResult(
		f.db,
		{
			reportId: "report:1",
			buildRef: r.build.ref,
			executionRef: "execution:1",
			outcome: "failed",
			evidence: [],
			summary: "失敗",
			improvement: "直す",
			expectedRevision: 0,
		},
		f.auth,
	);
	const prepared = f.write(() =>
		f.service.prepareReflection(f.db, "execution:1", f.auth),
	)!;
	f.setOutput({
		sections: [{ id: "a", body: "案" }],
		conditions: ["条件"],
		evidence: [],
	});
	const result = await f.service.propose(prepared, {
		signal: new AbortController().signal,
		reserve: async () => {
			f.write(() => f.service.reserveReflection(f.db, prepared, f.auth));
		},
	});
	const proposal = f.write(() =>
		f.service.saveProposal(f.db, prepared, result, f.auth),
	)!;
	expect(() =>
		f.service.markExecutionVerified(
			f.db,
			proposal.ref,
			proposal.revision,
			f.auth,
		),
	).toThrow("verification_required");
});
