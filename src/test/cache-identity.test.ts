import { expect, test } from "bun:test";
import { defaultCacheIdentityManifest } from "../eval/index.js";
import { fixture, ready } from "./fixture.js";
import { INSTRUCTION_VERSION } from "../instructions/build.js";

test("same task with refreshed deadline hits cache", async () => {
	const f = fixture();
	await ready(f);
	f.request.requestId = "r2";
	f.request.limits.deadlineAt -= 1;
	const pending = f.submit();
	expect(pending.kind).toBe("ready");
});

test("acceptance change misses cache", async () => {
	const f = fixture();
	await ready(f);
	f.request.requestId = "r2";
	f.request.task = {
		...f.request.task,
		acceptance: [{ id: "a2", text: "別の受入" }],
	};
	const pending = f.submit();
	expect(pending.kind).toBe("pending");
});

test("new builds stamp generator instructions for usable()", async () => {
	const f = fixture();
	const r = await ready(f);
	expect(r.build.generator?.instructions).toBe(INSTRUCTION_VERSION);
	expect(r.build.generator?.contractVersion).toBe("skillsmith.v1");
});

test("usable refuses builds whose generator instructions drifted", async () => {
	const f = fixture();
	const r = await ready(f);
	const build = f.service.get(f.db, r.build.requestRef, f.auth);
	expect(build.kind).toBe("ready");
	// Simulate an old build row with a different instruction digest.
	const row = f.db
		.query("SELECT data_json FROM knowledge_builds WHERE ref=?")
		.get(r.build.ref) as { data_json: string };
	const parsed = JSON.parse(row.data_json);
	parsed.generator = {
		instructions: "build.outdated",
		contractVersion: "skillsmith.v1",
	};
	f.db
		.query("UPDATE knowledge_builds SET data_json=? WHERE ref=?")
		.run(JSON.stringify(parsed), r.build.ref);
	const got = f.service.get(f.db, r.build.requestRef, f.auth);
	expect(got.kind).toBe("rejected");
	if (got.kind === "rejected") expect(got.code).toBe("build_revoked");
});

test("cache identity manifest separates deadline from content keys", () => {
	const m = defaultCacheIdentityManifest();
	expect(m.executionOnlyKeys).toContain("deadlineAt");
	expect(m.contentKeys).not.toContain("deadlineAt");
	expect(m.generatorKeys).toContain("instructions");
});
