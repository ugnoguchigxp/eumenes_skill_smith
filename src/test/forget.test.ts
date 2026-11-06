import { expect, test } from "bun:test";
import { fixture, ready } from "./fixture.js";
test("revocation immediately blocks indirect descendants before bounded erasure finishes", async () => {
	const f = fixture(),
		r = await ready(f);
	const progress = f.write(() => f.service.forget(f.db, ["message:1"], 1));
	expect(progress.pending.length).toBeGreaterThan(0);
	expect(f.service.get(f.db, r.requestRef, f.auth).kind).toBe("rejected");
	let pending = progress.pending;
	while (pending.length)
		pending = f.write(() => f.service.forget(f.db, pending, 1)).pending;
	expect(f.db.query("SELECT COUNT(*) n FROM knowledge_builds").get()).toEqual({
		n: 0,
	});
	expect(f.db.query("SELECT COUNT(*) n FROM knowledge_requests").get()).toEqual(
		{ n: 0 },
	);
});
test("forgetting a source while generation runs prevents delayed resurrection", async () => {
	const f = fixture(),
		r = f.submit(),
		work = await f.run(r.requestRef!);
	f.write(() => f.service.forget(f.db, ["message:1"]));
	expect(work.settle()).toBe(false);
	expect(f.service.get(f.db, r.requestRef!, f.auth).kind).toBe("rejected");
});
test("source changes are revalidated before each external distribution", async () => {
	const f = fixture({ external: true });
	f.setDecision({
		kind: "ready",
		strategy: "reuse",
		sourceRefs: ["external:1"],
		sections: [],
		patches: [],
		requiredCapabilities: [],
		verification: ["確認する"],
		assumptions: [],
	});
	const r = await ready(f);
	f.setSourceValid(false);
	const reply = await f.service.getValidated(
		r.requestRef,
		f.auth,
		f.read,
		new AbortController().signal,
	);
	expect(reply.kind).toBe("rejected");
	expect(f.modelCalls()).toBe(1);
});
