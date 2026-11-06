import { expect, test } from "bun:test";
import { fixture, ready } from "./fixture.js";
test("results bind to a verified execution and deduplicate reports and corrected totals", async () => {
	const f = fixture(),
		r = await ready(f);
	f.service.bindUse(f.db, r.build.ref, "execution:1", f.auth, f.request);
	const report = {
		reportId: "report:1",
		buildRef: r.build.ref,
		executionRef: "execution:1",
		outcome: "succeeded",
		evidence: [],
		summary: "照合を完了した",
		expectedRevision: 0,
	};
	const first = f.write(() => f.service.reportResult(f.db, report, f.auth));
	expect(f.write(() => f.service.reportResult(f.db, report, f.auth))).toEqual(
		first,
	);
	expect(() =>
		f.write(() =>
			f.service.reportResult(f.db, { ...report, reportId: "report:2" }, f.auth),
		),
	).toThrow("result_conflict");
	f.write(() =>
		f.service.reportResult(
			f.db,
			{
				...report,
				reportId: "report:2",
				expectedRevision: 1,
				outcome: "failed",
			},
			f.auth,
		),
	);
	expect(f.db.query("SELECT COUNT(*) n FROM knowledge_results").get()).toEqual({
		n: 1,
	});
});
test("a different child goal does not inherit a parent's build by ID alone", async () => {
	const f = fixture(),
		r = await ready(f);
	expect(() =>
		f.service.bindUse(f.db, r.build.ref, "execution:2", f.auth, {
			...f.request,
			task: { ...f.request.task, goal: "別の目的" },
		}),
	).toThrow("application_mismatch");
});
test("an unrelated scope and unbound execution cannot report results", async () => {
	const f = fixture(),
		r = await ready(f);
	const report = {
		reportId: "report:1",
		buildRef: r.build.ref,
		executionRef: "other",
		outcome: "succeeded",
		evidence: [],
		summary: "完了",
		expectedRevision: 0,
	};
	expect(() => f.service.reportResult(f.db, report, f.auth)).toThrow(
		"permission_denied",
	);
});
test("ordinary successful results do not trigger an unconditional reflection", async () => {
	const f = fixture(),
		r = await ready(f);
	f.service.bindUse(f.db, r.build.ref, "execution:1", f.auth, f.request);
	f.service.reportResult(
		f.db,
		{
			reportId: "r",
			buildRef: r.build.ref,
			executionRef: "execution:1",
			outcome: "succeeded",
			evidence: [],
			summary: "完了",
			expectedRevision: 0,
		},
		f.auth,
	);
	expect(f.service.prepareReflection(f.db, "execution:1", f.auth)).toBeNull();
	expect(f.modelCalls()).toBe(1);
});
test("a build ID cannot be bound by a different principal in the same scope", async () => {
	const f = fixture(),
		r = await ready(f);
	expect(() =>
		f.service.bindUse(
			f.db,
			r.build.ref,
			"execution:2",
			{ ...f.auth, principal: "another-user" },
			f.request,
		),
	).toThrow("permission_denied");
});
