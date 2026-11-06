import { expect, test } from "bun:test";
import { fixture, ready } from "./fixture.js";

test("propose receives build body and success/failure contrast", async () => {
	const f = fixture();
	const r = await ready(f);
	f.service.bindUse(f.db, r.build.ref, "execution:ok", f.auth, f.request);
	f.service.bindUse(f.db, r.build.ref, "execution:bad", f.auth, f.request);
	f.service.reportResult(
		f.db,
		{
			reportId: "report:ok",
			buildRef: r.build.ref,
			executionRef: "execution:ok",
			outcome: "succeeded",
			evidence: [],
			summary: "成功した要約",
			expectedRevision: 0,
		},
		f.auth,
	);
	f.service.reportResult(
		f.db,
		{
			reportId: "report:bad",
			buildRef: r.build.ref,
			executionRef: "execution:bad",
			outcome: "failed",
			evidence: [],
			summary: "失敗した要約",
			improvement: "前提を明記する",
			expectedRevision: 0,
		},
		f.auth,
	);
	const prepared = f.write(() =>
		f.service.prepareReflection(f.db, "execution:bad", f.auth),
	)!;
	expect(prepared.grounding?.buildBody).toContain(
		f.request.task.acceptance[0]!.text,
	);
	expect(prepared.grounding?.contrast.succeeded).toContain("成功した要約");
	expect(prepared.grounding?.contrast.failed).toContain("失敗した要約");
	let seen: unknown;
	f.ports.inference.complete = async (input) => {
		seen = structuredClone(input.data);
		return {
			value: {
				sections: [{ id: "verify", body: "反例も確認する。" }],
				conditions: ["複数根拠"],
				evidence: [],
			},
			receipt: "receipt",
			inputTokens: 1,
			outputTokens: 1,
		};
	};
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
	expect((seen as { buildBody: string }).buildBody).toContain("受入条件");
	expect(
		(seen as { contrast: { succeeded: string[] } }).contrast.succeeded,
	).toContain("成功した要約");
});
