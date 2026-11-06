import { expect, test } from "bun:test";
import { fixture } from "./fixture.js";

test("model may return needs_input early when retrieval is poor", async () => {
	const f = fixture({ external: true });
	f.ports.source!.search = async () => ({
		cards: [],
		warnings: [],
		degraded: ["index_cold"],
		truncated: true,
	});
	f.setEvidence([]);
	f.setDecision({
		kind: "needs_input",
		missing: ["使える根拠資料が候補にない"],
	});
	const pending = f.submit();
	const work = await f.run(pending.requestRef!);
	expect(work.result.decision.kind).toBe("needs_input");
	expect(work.settle()).toBe(true);
	expect(f.service.get(f.db, pending.requestRef!, f.auth).kind).toBe(
		"needs_input",
	);
});

test("empty local retrieval can end as unavailable without composing", async () => {
	const f = fixture();
	f.setEvidence([]);
	f.setDecision({ kind: "unavailable", code: "no_usable_evidence" });
	const pending = f.submit();
	const work = await f.run(pending.requestRef!);
	expect(work.result.decision.kind).toBe("unavailable");
	expect(work.settle()).toBe(true);
});
