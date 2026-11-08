import { expect, test } from "bun:test";
import { fixture } from "./fixture.js";
import {
	createBuildJobHandler,
	createBuildQueueJobs,
	type BuildQueue,
} from "../index.js";
import { sqliteRepository } from "../sqlite/index.js";

function queueFixture() {
	const f = fixture();
	let payload: { requestRef: string; epoch: number } | null = null;
	let scope = "",
		cancelCallback: (() => void) | undefined;
	const queue: BuildQueue<typeof f.db> = {
		enqueueInTransaction: (_tx, input) => {
			payload = input.payload;
			scope = input.scope;
			return { job: { id: "real-shaped-job" } };
		},
		cancelInTransaction: () => {
			cancelCallback?.();
			return null;
		},
	};
	f.ports.jobs = createBuildQueueJobs(queue);
	const handler = createBuildJobHandler({
		service: f.service,
		write: async (op) => f.write(() => op(f.db)),
		authorityFor: (tx, ref) =>
			sqliteRepository.request(tx, ref)?.authority ?? null,
	});
	const pending = f.submit();
	const ref = pending.requestRef!;
	const claim = () => ({
		jobId: "real-shaped-job",
		scope,
		subjectRef: ref,
		payload: payload!,
	});
	return {
		...f,
		handler,
		ref,
		claim,
		onCancel: (cb: () => void) => {
			cancelCallback = cb;
		},
	};
}

test("queue handler reserves, executes outside the writer and confirms domain settlement", async () => {
	const f = queueFixture();
	const stage = f.write(() => f.handler.prepareInTransaction(f.db, f.claim()));
	if (stage.status !== "ready") throw Error("prepare_required");
	const result = await f.handler.execute(stage.input, {
		signal: new AbortController().signal,
	});
	expect(sqliteRepository.request(f.db, f.ref)!.usage.modelCalls).toBe(1);
	expect(
		f.write(() =>
			f.handler.settleInTransaction(f.db, f.claim(), stage.input, {
				type: "success",
				result,
			}),
		),
	).toBe("applied");
	expect(
		(
			await f.service.getSkillDelivery(
				f.ref,
				f.auth,
				f.read,
				new AbortController().signal,
			)
		).kind,
	).toBe("ready");
});

test("queue handler refuses false mutation confirmation instead of completing", async () => {
	const f = queueFixture();
	const stage = f.write(() => f.handler.prepareInTransaction(f.db, f.claim()));
	if (stage.status !== "ready") throw Error("prepare_required");
	const result = await f.handler.execute(stage.input, {
		signal: new AbortController().signal,
	});
	f.setReceipts(false);
	expect(
		f.write(() =>
			f.handler.settleInTransaction(f.db, f.claim(), stage.input, {
				type: "success",
				result,
			}),
		),
	).toEqual({ status: "failed", errorCode: "domain_settlement_refused" });
	expect(f.service.get(f.db, f.ref, f.auth).kind).toBe("rejected");
});

test("queue scope and subject cannot borrow the authority of another stored request", () => {
	const f = queueFixture();
	expect(
		f.handler.prepareInTransaction(f.db, { ...f.claim(), scope: "foreign" }),
	).toEqual({ status: "stale", reason: "permission_denied" });
	expect(
		f.handler.prepareInTransaction(f.db, {
			...f.claim(),
			subjectRef: "different",
		}),
	).toEqual({ status: "stale", reason: "permission_denied" });
	expect(f.modelCalls()).toBe(0);
});

test("queue callbacks cannot operate with a different job ID or stale epoch", () => {
	const f = queueFixture();
	const otherJob = { ...f.claim(), jobId: "different-job" };
	const staleEpoch = {
		...f.claim(),
		payload: { ...f.claim().payload, epoch: 9 },
	};
	expect(f.handler.prepareInTransaction(f.db, otherJob)).toEqual({
		status: "stale",
		reason: "request_stale",
	});
	f.write(() => {
		f.handler.cancelInTransaction(f.db, otherJob, "queue");
		f.handler.cancelInTransaction(f.db, staleEpoch, "queue");
		expect(
			f.handler.settleInTransaction(f.db, otherJob, null, {
				type: "interrupted",
				errorCode: "backend_restarted",
			}),
		).toBe("stale");
	});
	expect(f.service.get(f.db, f.ref, f.auth).kind).toBe("pending");
});

test("recovery without an in-memory execution confirms interruption and retains reservations", async () => {
	const f = queueFixture();
	const stage = f.write(() => f.handler.prepareInTransaction(f.db, f.claim()));
	if (stage.status !== "ready") throw Error("prepare_required");
	const result = await f.handler.execute(stage.input, {
		signal: new AbortController().signal,
	});
	f.write(() => {
		expect(
			f.handler.settleInTransaction(f.db, f.claim(), null, {
				type: "interrupted",
				errorCode: "backend_restarted",
			}),
		).toBe("applied");
		expect(
			f.handler.settleInTransaction(f.db, f.claim(), stage.input, {
				type: "success",
				result,
			}),
		).toEqual({ status: "failed", errorCode: "domain_settlement_refused" });
	});
	expect(sqliteRepository.request(f.db, f.ref)!.usage.modelCalls).toBe(1);
	expect(f.service.get(f.db, f.ref, f.auth)).toMatchObject({
		kind: "unavailable",
		code: "backend_restarted",
	});
});

test("bidirectional queue cancellation is finite and leaves a durable cancelled request", () => {
	const f = queueFixture();
	let calls = 0;
	f.onCancel(() => {
		if (++calls > 2) throw Error("recursive_queue_cancel");
		f.handler.cancelInTransaction(f.db, f.claim(), "user");
	});
	expect(f.write(() => f.service.cancel(f.db, f.ref, f.auth))).toBe(true);
	expect(calls).toBe(1);
	expect(f.service.get(f.db, f.ref, f.auth).kind).toBe("cancelled");
});

test("queue-origin cancellation does not notify the same queue again", () => {
	const f = queueFixture();
	let echoes = 0;
	f.onCancel(() => {
		echoes++;
	});
	f.write(() => f.handler.cancelInTransaction(f.db, f.claim(), "queue"));
	expect(echoes).toBe(0);
	expect(f.service.get(f.db, f.ref, f.auth).kind).toBe("cancelled");
});

test("queue-owned failure retains reservations without changing the queue during its settlement", async () => {
	const f = queueFixture();
	const stage = f.write(() => f.handler.prepareInTransaction(f.db, f.claim()));
	if (stage.status !== "ready") throw Error("prepare_required");
	f.ports.inference.complete = async () => {
		throw Error("provider_failed");
	};
	await expect(
		f.handler.execute(stage.input, { signal: new AbortController().signal }),
	).rejects.toThrow("provider_failed");
	f.onCancel(() => {
		throw Error("unexpected_queue_echo");
	});
	expect(
		f.write(() =>
			f.handler.settleInTransaction(f.db, f.claim(), stage.input, {
				type: "failed",
				errorCode: "provider_failed",
			}),
		),
	).toBe("applied");
	expect(sqliteRepository.request(f.db, f.ref)!.usage.modelCalls).toBe(1);
	expect(f.service.get(f.db, f.ref, f.auth)).toMatchObject({
		kind: "unavailable",
		code: "provider_failed",
	});
});
