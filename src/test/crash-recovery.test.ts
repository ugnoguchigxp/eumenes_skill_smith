import { test, expect } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture } from "./fixture.js";

for (const phase of [
	"accepted",
	"reserved",
	"response",
	"transaction",
	"settled",
	"delivered",
	"acknowledged",
	"revoked",
]) {
	test(
		"SIGKILL recovery preserves durable invariants at " + phase,
		async () => {
			const dir = mkdtempSync(
				join(realpathSync(tmpdir()), "skillsmith-crash-"),
			);
			try {
				const path = join(dir, "state.sqlite");
				const child = Bun.spawn(
					[process.execPath, "src/test/recovery-worker.ts", path, phase],
					{
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const exit = await child.exited;
				const error = await new Response(child.stderr).text();
				expect(error).toBe("");
				expect(exit).not.toBe(0);
				expect(child.signalCode).toBe("SIGKILL");
				const f = fixture({
					path,
					existing: true,
					parent: phase === "accepted",
				});
				const row = f.ports.repository.requestByKey(
					f.db,
					f.auth.scope,
					f.request.requestId,
				)!;
				expect(row).not.toBeNull();
				if (phase === "revoked") {
					expect(f.service.get(f.db, row.ref, f.auth).kind).toBe("rejected");
					return;
				}
				if (phase === "accepted") {
					expect(row.waitingParent).toBe("parent:1");
					expect(f.ports.repository.deliveries(f.db, 10)).toEqual([]);
					f.write(() => f.service.activate(f.db, row.ref, f.auth, true));
				}
				if (["reserved", "response", "transaction"].includes(phase)) {
					expect(row.usage.modelCalls).toBe(1);
					expect(row.outcome).toBeNull();
					expect(
						f.db.query("SELECT count(*) AS n FROM knowledge_builds").get(),
					).toEqual({ n: 0 });
					expect(f.ports.repository.deliveries(f.db, 10)).toEqual([]);
				}
				if (!row.outcome) {
					const work = await f.run(row.ref);
					expect(work.settle()).toBe(true);
					expect(
						f.ports.repository.request(f.db, row.ref)!.usage.modelCalls,
					).toBe(phase === "accepted" ? 1 : 2);
				} else {
					expect(f.submit().kind).toBe("ready");
					expect(f.modelCalls()).toBe(0);
				}
				const pending = f.ports.repository.deliveries(f.db, 10);
				if (phase === "acknowledged") expect(pending).toEqual([]);
				else {
					expect(pending).toHaveLength(1);
					expect(pending[0]!.id).toBe(row.ref + ":result");
					if (phase === "delivered")
						expect(
							JSON.parse(readFileSync(path + ".delivery", "utf8")).id,
						).toBe(pending[0]!.id);
					f.write(() => f.ports.repository.ackDelivery(f.db, pending[0]!.id));
					f.write(() => f.ports.repository.ackDelivery(f.db, pending[0]!.id));
					expect(f.ports.repository.deliveries(f.db, 10)).toEqual([]);
				}
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
}
