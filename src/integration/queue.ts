import { z } from "zod";
import type { Authority, Executed, Prepared } from "../contracts/types.js";
import type { Ports } from "../contracts/ports.js";
import type { createSkillSmith } from "../service/index.js";
import { requireThat } from "../service/identity.js";

export const BUILD_JOB_KIND = "knowledge.build.v1";
export const buildJobPayloadSchema = z.strictObject({
	requestRef: z.string().min(1).max(160),
	epoch: z.number().int().nonnegative(),
});
type Payload = z.infer<typeof buildJobPayloadSchema>;
type Service<Tx> = ReturnType<typeof createSkillSmith<Tx>>;
type Input = { prepared: Prepared; authority: Authority };
type Claim = { scope: string; subjectRef: string | null; payload: Payload };
type Outcome =
	| { type: "success"; result: Executed }
	| { type: "failed" | "interrupted" | "retry"; errorCode: string }
	| { type: "expired" };
export interface BuildJobHandler<Tx> {
	kind: string;
	payloadVersions: readonly number[];
	schema: typeof buildJobPayloadSchema;
	recovery: "interrupt";
	resourceKey: string;
	prepareInTransaction(
		tx: Tx,
		claim: Claim,
	): { status: "ready"; input: Input } | { status: "stale"; reason: string };
	execute(input: Input, context: { signal: AbortSignal }): Promise<Executed>;
	classify(error: unknown): "fail";
	settleInTransaction(
		tx: Tx,
		claim: Claim,
		input: Input | null,
		outcome: Outcome,
	): "applied" | "stale" | { status: "failed"; errorCode: string };
	cancelInTransaction(tx: Tx, job: { payload: Payload }, reason: string): void;
}
/** Public Eumenes queue operations; no domain-owned tables are accessed here. */
export interface BuildQueue<Tx> {
	enqueueInTransaction(
		tx: Tx,
		input: {
			scope: string;
			kind: string;
			payloadVersion: number;
			dedupeKey: string;
			payload: Payload;
			subjectRef: string;
			lane: "background";
			resourceKey: string;
			concurrencyKey: string;
			deadlineAtMs: number;
			maxAttempts: number;
		},
	): { job: { id: string } };
	cancelInTransaction(tx: Tx, jobId: string, reason: string): unknown;
}
export function createBuildQueueJobs<Tx>(
	queue: BuildQueue<Tx>,
): Ports<Tx>["jobs"] {
	return {
		enqueue(tx, input) {
			requireThat(input.scope, "queue_scope_required");
			return queue.enqueueInTransaction(tx, {
				scope: input.scope,
				kind: BUILD_JOB_KIND,
				payloadVersion: 1,
				dedupeKey: input.requestRef + ":" + input.epoch,
				payload: { requestRef: input.requestRef, epoch: input.epoch },
				subjectRef: input.requestRef,
				lane: "background",
				resourceKey: "inference.llm",
				concurrencyKey: "skillsmith:" + input.requestRef,
				deadlineAtMs: input.deadlineAt,
				maxAttempts: 1,
			}).job.id;
		},
		cancel(tx, ref) {
			queue.cancelInTransaction(tx, ref, "skillsmith_cancelled");
		},
	};
}
/** Prepare/settle/cancel run in the queue's writer; execute alone performs external work. */
export function createBuildJobHandler<Tx>(options: {
	service: Service<Tx>;
	write: <T>(op: (tx: Tx) => T) => Promise<T>;
	authorityFor: (tx: Tx, requestRef: string) => Authority | null;
}): BuildJobHandler<Tx> {
	const { service, write, authorityFor } = options;
	return {
		kind: BUILD_JOB_KIND,
		payloadVersions: [1],
		schema: buildJobPayloadSchema,
		recovery: "interrupt",
		resourceKey: "inference.llm",
		prepareInTransaction(tx, claim) {
			const auth = authorityFor(tx, claim.payload.requestRef);
			if (
				!auth ||
				auth.scope !== claim.scope ||
				claim.subjectRef !== claim.payload.requestRef
			)
				return { status: "stale", reason: "permission_denied" };
			const prepared = service.prepare(
				tx,
				claim.payload.requestRef,
				claim.payload.epoch,
				auth,
			);
			return prepared
				? { status: "ready", input: { prepared, authority: auth } }
				: { status: "stale", reason: "request_stale" };
		},
		execute(input, { signal }) {
			return service.execute(input.prepared, {
				signal,
				reserve: async (kind) => {
					await write((tx) =>
						service.reserve(tx, input.prepared, kind, input.authority),
					);
				},
				noteUsage: async (usage) => {
					const applied = await write((tx) =>
						service.noteUsage(tx, input.prepared, input.authority, usage),
					);
					requireThat(applied, "request_stale");
				},
			});
		},
		classify: () => "fail",
		settleInTransaction(tx, _claim, input, outcome) {
			if (!input) return "stale";
			if (outcome.type === "success")
				return service.settle(
					tx,
					input.prepared,
					outcome.result,
					input.authority,
				)
					? "applied"
					: { status: "failed", errorCode: "domain_settlement_refused" };
			const code =
				outcome.type === "expired" ? "deadline_exceeded" : outcome.errorCode;
			return service.fail(
				tx,
				input.prepared,
				input.authority,
				code,
				undefined,
				"job",
			)
				? "applied"
				: "stale";
		},
		cancelInTransaction(tx, { payload }) {
			const auth = authorityFor(tx, payload.requestRef);
			if (auth) service.cancel(tx, payload.requestRef, auth, "job");
		},
	};
}
