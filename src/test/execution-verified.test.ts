import { expect, test } from "bun:test";
import { fixture, ready } from "./fixture.js";
import { sqliteRepository } from "../sqlite/index.js";

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

test("correcting succeeded report to failed clears executionVerified", async () => {
	const f = fixture();
	const r = await ready(f);
	f.service.bindUse(f.db, r.build.ref, "exec", f.auth, f.request);
	const report = {
		reportId: "r1",
		buildRef: r.build.ref,
		executionRef: "exec",
		outcome: "succeeded" as const,
		evidence: [],
		summary: "success",
		improvement: "improve",
		expectedRevision: 0,
	};
	f.service.reportResult(f.db, report, f.auth);
	const s = f.service.prepareReflection(f.db, "exec", f.auth)!;
	f.setOutput({
		sections: [{ id: "s", body: "never executed new candidate" }],
		conditions: ["c"],
		evidence: [],
	});
	const result = await f.service.propose(s, {
		signal: new AbortController().signal,
		reserve: async () => f.service.reserveReflection(f.db, s, f.auth),
	});
	const p = f.service.saveProposal(f.db, s, result, f.auth)!;
	f.service.markExecutionVerified(f.db, p.ref, p.revision, f.auth);
	f.service.reportResult(
		f.db,
		{
			...report,
			reportId: "r2",
			outcome: "failed",
			summary: "correction",
			expectedRevision: 1,
		},
		f.auth,
	);
	const after = sqliteRepository.proposal(f.db, p.ref)!;
	expect(after.executionVerified).toBeUndefined();
});

test("candidateVerification binds to proposal digest and invalidates on text change", async () => {
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
	const digest = f.service.proposalContentDigest(proposal);
	const bound = f.service.bindCandidateVerification(
		f.db,
		proposal.ref,
		proposal.revision,
		{ proposalDigest: digest, outcome: "failed" },
		f.auth,
	);
	expect(bound.candidateVerification?.status).toBe("bound");
	expect(bound.candidateVerification?.outcome).toBe("failed");
	expect(f.service.candidateVerificationStatus(bound)).toBe("bound");
	// Mutate proposal text → status reader reports invalidated without claiming success.
	bound.sections = [{ id: "verify", body: "別の文面" }];
	expect(f.service.candidateVerificationStatus(bound)).toBe("invalidated");
});

test("bindCandidateVerification rejects mismatched digest", async () => {
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
			evidence: [],
			summary: "達成",
			improvement: "x",
			expectedRevision: 0,
		},
		f.auth,
	);
	const prepared = f.write(() =>
		f.service.prepareReflection(f.db, "execution:1", f.auth),
	)!;
	f.setOutput({
		sections: [{ id: "a", body: "案" }],
		conditions: ["c"],
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
		f.service.bindCandidateVerification(
			f.db,
			proposal.ref,
			proposal.revision,
			{ proposalDigest: "wrong", outcome: "succeeded" },
			f.auth,
		),
	).toThrow("verification_required");
});
