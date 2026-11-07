import { expect, test } from "bun:test";
import { fixture, ready } from "./fixture.js";
test("parent-bound requests cannot enqueue before release or enqueue twice", () => {
	const f = fixture({ parent: true });
	const r = f.submit();
	expect(f.db.query("SELECT COUNT(*) n FROM fixture_jobs").get()).toEqual({
		n: 0,
	});
	expect(f.service.activate(f.db, r.requestRef!, f.auth, false)).toBe(false);
	expect(
		f.write(() => f.service.activate(f.db, r.requestRef!, f.auth, true)),
	).toBe(true);
	expect(
		f.write(() => f.service.activate(f.db, r.requestRef!, f.auth, true)),
	).toBe(false);
	expect(f.db.query("SELECT COUNT(*) n FROM fixture_jobs").get()).toEqual({
		n: 1,
	});
});
test("same request replay returns the same reference and conflicting input rolls back", () => {
	const f = fixture(),
		first = f.submit(),
		second = f.submit();
	expect(second.requestRef).toBe(first.requestRef);
	expect(() =>
		f.submit({ ...f.request, task: { ...f.request.task, goal: "異なる目的" } }),
	).toThrow("request_conflict");
	expect(f.db.query("SELECT COUNT(*) n FROM fixture_jobs").get()).toEqual({
		n: 1,
	});
});
test("an enqueue failure rolls back even a partially inserted job", () => {
	const f = fixture(),
		enqueue = f.ports.jobs.enqueue;
	f.ports.jobs.enqueue = (tx, input) => {
		enqueue(tx, input);
		throw new Error("queue_failed");
	};
	expect(() => f.submit()).toThrow("queue_failed");
	expect(f.db.query("SELECT COUNT(*) n FROM fixture_jobs").get()).toEqual({
		n: 0,
	});
	expect(f.db.query("SELECT COUNT(*) n FROM knowledge_requests").get()).toEqual(
		{ n: 0 },
	);
});
test("cancelled requests reject late model results", async () => {
	const f = fixture(),
		r = f.submit(),
		work = await f.run(r.requestRef!);
	expect(f.write(() => f.service.cancel(f.db, r.requestRef!, f.auth))).toBe(
		true,
	);
	expect(work.settle()).toBe(false);
	expect(f.service.get(f.db, r.requestRef!, f.auth).kind).toBe("cancelled");
	expect(f.db.query("SELECT COUNT(*) n FROM knowledge_builds").get()).toEqual({
		n: 0,
	});
});
test("expired activation never launches a model", () => {
	const f = fixture({ parent: true }),
		r = f.submit();
	f.advance(120001);
	expect(f.service.activate(f.db, r.requestRef!, f.auth, true)).toBe(false);
	expect(f.service.get(f.db, r.requestRef!, f.auth).kind).toBe("expired");
	expect(f.modelCalls()).toBe(0);
});
test("generation deadline does not invalidate a build completed in time", async () => {
	const f = fixture(),
		r = await ready(f);
	f.advance(120001);
	expect(f.service.get(f.db, r.requestRef, f.auth).kind).toBe("ready");
});
test("scope and authority epoch are checked on every read", async () => {
	const f = fixture(),
		r = await ready(f);
	expect(
		f.service.get(f.db, r.requestRef, { ...f.auth, scope: "other" }).kind,
	).toBe("rejected");
	expect(f.service.get(f.db, r.requestRef, { ...f.auth, epoch: 1 }).kind).toBe(
		"rejected",
	);
	f.setValid(false);
	expect(f.service.get(f.db, r.requestRef, f.auth).kind).toBe("rejected");
});
test("a stale producer cannot adopt after a newer preparation", async () => {
	const f = fixture(),
		r = f.submit(),
		first = await f.run(r.requestRef!);
	const second = f.write(() =>
		f.service.prepare(f.db, r.requestRef!, 0, f.auth),
	);
	expect(second).not.toBeNull();
	expect(first.settle()).toBe(false);
});
test("failed external work retains the consumed budget", async () => {
	const f = fixture({ external: true });
	const r = f.submit({
		...f.request,
		limits: { ...f.request.limits, sourceCalls: 1 },
	});
	await expect(f.run(r.requestRef!)).rejects.toThrow("budget_exceeded");
	expect(f.service.pending(f.db)[0]!.usage.sourceCalls).toBe(1);
	expect(f.modelCalls()).toBe(0);
});
test("a lost inference receipt cannot produce a build", async () => {
	const f = fixture(),
		r = f.submit(),
		work = await f.run(r.requestRef!);
	f.setReceipts(false);
	expect(work.settle()).toBe(false);
	expect(f.service.get(f.db, r.requestRef!, f.auth).kind).toBe("rejected");
});
test("delivery insertion failure rolls back the build and terminal outcome", async () => {
	const f = fixture(),
		r = f.submit(),
		work = await f.run(r.requestRef!);
	f.db.exec(
		"CREATE TRIGGER reject_delivery BEFORE INSERT ON knowledge_deliveries BEGIN SELECT RAISE(ABORT,'fixture_delivery_failed'); END",
	);
	expect(() => work.settle()).toThrow("fixture_delivery_failed");
	expect(f.db.query("SELECT COUNT(*) n FROM knowledge_builds").get()).toEqual({
		n: 0,
	});
	expect(f.service.get(f.db, r.requestRef!, f.auth).kind).toBe("pending");
});
test("an expired status read never mutates a read-only transaction", () => {
	const f = fixture({ parent: true }),
		r = f.submit();
	f.advance(120001);
	f.db.exec("PRAGMA query_only=ON");
	expect(f.service.get(f.db, r.requestRef!, f.auth).kind).toBe("expired");
});
test("an old producer failure cannot terminate a new producer", async () => {
	const f = fixture(),
		r = f.submit(),
		work = await f.run(r.requestRef!);
	const next = f.write(() => f.service.prepare(f.db, r.requestRef!, 0, f.auth));
	expect(next).not.toBeNull();
	expect(
		f.write(() => f.service.fail(f.db, work.prepared, f.auth, "old_failure")),
	).toBe(false);
	expect(f.service.get(f.db, r.requestRef!, f.auth).kind).toBe("pending");
});
test("external read failure returns unavailable without restarting generation", async () => {
	const f = fixture({ external: true });
	f.setDecision({
		kind: "ready",
		strategy: "reuse",
		sourceRefs: ["external:1"],
		sections: [],
		patches: [],
		requiredCapabilities: [],
		verification: ["確認"],
		assumptions: [],
	});
	const r = await ready(f);
	f.ports.source!.validate = async () => {
		throw Error("transport");
	};
	expect(
		(
			await f.service.getValidated(
				r.requestRef,
				f.auth,
				f.read,
				new AbortController().signal,
			)
		).kind,
	).toBe("unavailable");
	expect(f.modelCalls()).toBe(1);
});
test("report-only authorization cannot read a build", async () => {
	const f = fixture(),
		r = await ready(f);
	expect(
		f.service.get(f.db, r.requestRef, { ...f.auth, permissions: ["report"] })
			.kind,
	).toBe("rejected");
});

for (const denial of [
	"principal",
	"scope",
	"epoch",
	"permission",
	"revoked",
] as const) {
	test(`unauthorized failure (${denial}) cannot mutate usage or revision`, () => {
		const f = fixture();
		const request = f.submit();
		const prepared = f.write(() =>
			f.service.prepare(f.db, request.requestRef!, 0, f.auth),
		)!;
		const before = f.ports.repository.request(f.db, request.requestRef!);
		const auth = structuredClone(f.auth);
		if (denial === "principal") auth.principal = "other";
		if (denial === "scope") auth.scope = "other";
		if (denial === "epoch") auth.epoch++;
		if (denial === "permission") auth.permissions = ["report"];
		if (denial === "revoked") f.setValid(false);
		expect(
			f.write(() =>
				f.service.fail(f.db, prepared, auth, "failed", {
					input: 37,
					output: 9,
					reasoningTokens: 4,
					cachedInputTokens: 2,
				}),
			),
		).toBe(false);
		expect(f.ports.repository.request(f.db, request.requestRef!)).toEqual(
			before,
		);
	});
}
test("authorized failure preserves observed usage and terminates once", () => {
	const f = fixture();
	const request = f.submit();
	const prepared = f.write(() =>
		f.service.prepare(f.db, request.requestRef!, 0, f.auth),
	)!;
	expect(
		f.write(() =>
			f.service.fail(f.db, prepared, f.auth, "failed", {
				input: 37,
				output: 9,
			}),
		),
	).toBe(true);
	const row = f.ports.repository.request(f.db, request.requestRef!);
	expect(row?.usage.inputTokens).toBe(37);
	expect(row?.usage.outputTokens).toBe(9);
	expect(
		f.write(() =>
			f.service.fail(f.db, prepared, f.auth, "late", {
				input: 999,
				output: 999,
			}),
		),
	).toBe(false);
	expect(f.ports.repository.request(f.db, request.requestRef!)).toEqual(row);
});
