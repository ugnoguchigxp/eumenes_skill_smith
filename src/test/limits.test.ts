import { expect, test } from "bun:test";
import {
	createSkillSmith,
	defaultServiceLimits,
	resolveServiceLimits,
	serviceLimitsSchema,
} from "../index.js";
import { fixture } from "./fixture.js";

test("service limits keep package defaults when omitted", () => {
	expect(resolveServiceLimits()).toEqual({ ...defaultServiceLimits });
	expect(serviceLimitsSchema.parse(defaultServiceLimits)).toEqual(
		defaultServiceLimits,
	);
});

test("pending retryAfterMs follows injected service limits", () => {
	const f = fixture();
	f.ports.limits = { pendingRetryAfterMs: 2500 };
	const service = createSkillSmith(f.ports);
	const reply = f.write(() => service.submit(f.db, f.request, f.auth));
	expect(reply.kind).toBe("pending");
	if (reply.kind === "pending") expect(reply.retryAfterMs).toBe(2500);
});

test("submit horizon override rejects deadlines beyond the configured window", () => {
	const f = fixture();
	f.ports.limits = { maxSubmitHorizonMs: 1000 };
	const service = createSkillSmith(f.ports);
	expect(() =>
		f.write(() =>
			service.submit(
				f.db,
				{
					...f.request,
					limits: { ...f.request.limits, deadlineAt: f.ports.now() + 5000 },
				},
				f.auth,
			),
		),
	).toThrow("invalid_deadline");
});

test("build expiry uses the configured TTL", async () => {
	const f = fixture();
	f.ports.limits = { buildTtlMs: 60_000 };
	const service = createSkillSmith(f.ports);
	const receipt = f.write(() => service.submit(f.db, f.request, f.auth));
	expect(receipt.kind).toBe("pending");
	const row = service.pending(f.db)[0]!;
	const prepared = f.write(() =>
		service.prepare(f.db, row.ref, row.epoch, f.auth),
	)!;
	const result = await service.execute(prepared, {
		signal: new AbortController().signal,
		reserve: async (kind) => {
			f.write(() => service.reserve(f.db, prepared, kind, f.auth));
		},
	});
	f.write(() => service.settle(f.db, prepared, result, f.auth));
	const got = service.get(f.db, row.ref, f.auth);
	expect(got.kind).toBe("ready");
	if (got.kind === "ready")
		expect(got.build.expiresAt - got.build.createdAt).toBe(60_000);
});
