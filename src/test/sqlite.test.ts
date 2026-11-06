import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, ready } from "./fixture.js";
test("build identity and replay survive closing and reopening a real database", async () => {
	const dir = mkdtempSync(join(tmpdir(), "skillsmith-reopen-")),
		path = join(dir, "fixture.sqlite3");
	try {
		const first = fixture({ path }),
			r = await ready(first);
		first.dispose();
		const second = fixture({ path, existing: true });
		const replay = second.submit();
		expect(replay.kind).toBe("ready");
		if (replay.kind === "ready")
			expect(replay.build.digest).toBe(r.build.digest);
		expect(second.modelCalls()).toBe(0);
		second.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
test("a crash does not replenish a reserved call budget or lose a start reservation", () => {
	const dir = mkdtempSync(join(tmpdir(), "skillsmith-budget-")),
		path = join(dir, "fixture.sqlite3");
	try {
		const first = fixture({ path, parent: true }),
			r = first.submit();
		first.dispose();
		const second = fixture({ path, existing: true, parent: true });
		expect(second.service.pending(second.db)[0]!.waitingParent).toBe(
			"parent:1",
		);
		second.write(() =>
			second.service.activate(second.db, r.requestRef!, second.auth, true),
		);
		const row = second.service.pending(second.db)[0]!;
		const prepared = second.write(() =>
			second.service.prepare(second.db, row.ref, row.epoch, second.auth),
		)!;
		second.write(() =>
			second.service.reserve(second.db, prepared, "modelCalls", second.auth),
		);
		second.dispose();
		const third = fixture({ path, existing: true, parent: true });
		expect(third.service.pending(third.db)[0]!.usage.modelCalls).toBe(1);
		third.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
