/** Opt-in compatibility probe against real Eumenes public modules and a new temporary database.
 * Does not use a live service, production database, settings, credentials or local/cloud LLM.
 */
import "../../scripts/test-preload.js";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fixture } from "../../src/test/fixture-host.js";
import {
	createSkillSmith,
	createBuildQueueJobs,
	createBuildJobHandler,
} from "../../src/index.js";
import { migrations, sqliteRepository } from "../../src/sqlite/index.js";
const host = resolve(process.argv[2] ?? "../eumenes"),
	out = resolve(
		process.argv[3] ?? "artifacts/eumenes-queue-compatibility.json",
	);
const queueModule = await import(
	pathToFileURL(join(host, "api/domains/queue/index.ts")).href
);
const sqliteModule = await import(
	pathToFileURL(join(host, "api/infrastructure/sqlite/index.ts")).href
);
const dir = realpathSync(mkdtempSync(join(tmpdir(), "smith-real-queue-"))),
	file = join(dir, "state.sqlite");
const f = fixture(),
	auth = f.auth,
	assert = (value: unknown, message: string) => {
		if (!value) throw Error(message);
	};
const allMigrations = [...queueModule.migrations, ...migrations];
let store = sqliteModule.openStore(file, allMigrations);
let queue: ReturnType<typeof queueModule.createQueue>;
const results: Record<string, unknown> = {};
function attach() {
	queue = queueModule.createQueue(store, {
		now: f.ports.now,
		id: f.ports.id,
		random: () => 0,
		sleep: (_ms: number, signal?: AbortSignal) =>
			new Promise<void>((resolve) => {
				if (signal?.aborted) resolve();
				else signal?.addEventListener("abort", () => resolve(), { once: true });
			}),
	});
	const service = createSkillSmith({
		...f.ports,
		jobs: createBuildQueueJobs<typeof f.db>(queue),
		authority: {
			valid: (tx, a, refs) =>
				a.scope === auth.scope &&
				a.principal === auth.principal &&
				a.epoch === auth.epoch &&
				refs.every((r) => !sqliteRepository.blocked(tx, r)),
		},
	});
	queue.registerHandler(
		createBuildJobHandler<typeof f.db>({
			service,
			write: (op) => store.write(op),
			authorityFor: (tx, ref) =>
				sqliteRepository.request(tx, ref)?.authority ?? null,
		}),
	);
	return service;
}
async function run(jobRef: string) {
	for (let i = 0; i < 500; i++) {
		await queue.tick();
		await new Promise<void>((r) => setImmediate(r));
		const row = store.read((tx: typeof f.db) =>
			queue.getInTransaction(tx, jobRef),
		);
		if (
			row &&
			[
				"completed",
				"failed",
				"cancelled",
				"expired",
				"interrupted",
				"outcome_unknown",
			].includes(row.state)
		)
			return row;
	}
	throw Error("queue_did_not_settle");
}
try {
	let service = attach();
	const accepted = await store.write((tx: typeof f.db) =>
		service.submitArtifact(tx, f.request, auth),
	);
	assert(
		accepted.kind === "pending" && accepted.requestRef,
		"pending_required",
	);
	const requestRef = accepted.requestRef!,
		jobRef = store.read(
			(tx: typeof f.db) => sqliteRepository.request(tx, requestRef)!.jobRef!,
		);
	const job = await run(jobRef);
	assert(job.state === "completed", "completed_required");
	const delivered = await service.getSkillDelivery(
		requestRef,
		auth,
		(op) => store.read(op),
		new AbortController().signal,
	);
	assert(delivered.kind === "ready", "delivery_required");
	if (delivered.kind !== "ready") throw Error("delivery_required");
	const artifactDigest = delivered.skill.digest;
	await store.write((tx: typeof f.db) =>
		service.bindUse(
			tx,
			delivered.auditRef,
			"execution:actual-queue",
			auth,
			f.request,
		),
	);
	const receipt = await store.write((tx: typeof f.db) =>
		service.reportResult(
			tx,
			{
				reportId: "queue-report",
				buildRef: delivered.auditRef,
				executionRef: "execution:actual-queue",
				outcome: "explained",
				evidence: [],
				summary:
					"Fixed inference compatibility only; no production task execution.",
				expectedRevision: 0,
			},
			auth,
		),
	);
	results.completedDelivery = {
		jobState: job.state,
		delivery: delivered.kind,
		reportRevision: receipt.revision,
	};
	await queue.close();
	await store.close();
	store = sqliteModule.openStore(file, allMigrations);
	service = attach();
	await queue.recover();
	const restarted = await service.getSkillDelivery(
		requestRef,
		auth,
		(op) => store.read(op),
		new AbortController().signal,
	);
	assert(
		restarted.kind === "ready" && restarted.skill.digest === artifactDigest,
		"restart_bundle_changed",
	);
	results.restart =
		"same artifact after reopening real host store and recovering queue";
	const cancellationRequest = {
		...structuredClone(f.request),
		requestId: "cancel-real-queue",
		task: {
			...f.request.task,
			goal: "Cancel this pending compatibility request",
		},
	};
	const cancelled = await store.write((tx: typeof f.db) =>
		service.submitArtifact(tx, cancellationRequest, auth),
	);
	const cancelledJob = store.read(
		(tx: typeof f.db) =>
			sqliteRepository.request(tx, cancelled.requestRef!)!.jobRef!,
	);
	await store.write((tx: typeof f.db) =>
		service.cancel(tx, cancelled.requestRef!, auth),
	);
	assert(
		store.read((tx: typeof f.db) => queue.getInTransaction(tx, cancelledJob))
			.state === "cancelled",
		"queue_cancel_failed",
	);
	results.cancellation =
		"domain and actual queue cancelled without callback recursion";
	f.setReceipts(false);
	const rejected = await store.write((tx: typeof f.db) =>
		service.submitArtifact(
			tx,
			{
				...structuredClone(f.request),
				requestId: "reject-real-receipt",
				task: {
					...f.request.task,
					goal: "Reject the invalid fixture inference receipt",
				},
			},
			auth,
		),
	);
	const rejectedJob = store.read(
		(tx: typeof f.db) =>
			sqliteRepository.request(tx, rejected.requestRef!)!.jobRef!,
	);
	const failed = await run(rejectedJob);
	assert(failed.state === "failed", "false_settlement_marked_completed");
	assert(
		store.read((tx: typeof f.db) => service.get(tx, rejected.requestRef!, auth))
			.kind === "rejected",
		"domain_rejection_lost",
	);
	results.falseSettlement = { jobState: failed.state, domainState: "rejected" };
	f.setReceipts(true);
	const interrupted = await store.write((tx: typeof f.db) =>
		service.submitArtifact(
			tx,
			{
				...structuredClone(f.request),
				requestId: "interrupt-real-queue",
				task: { ...f.request.task, goal: "Interrupted compatibility request" },
			},
			auth,
		),
	);
	const interruptedRef = interrupted.requestRef!;
	const interruptedJob = store.read(
		(tx: typeof f.db) => sqliteRepository.request(tx, interruptedRef)!.jobRef!,
	);
	const previousQueue = queue;
	const previousComplete = f.ports.inference.complete;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	f.ports.inference.complete = async (...args) => {
		entered.resolve();
		await release.promise;
		return previousComplete(...args);
	};
	try {
		await previousQueue.tick();
		await Promise.race([
			entered.promise,
			Bun.sleep(2000).then(() => {
				throw Error("fixture_inference_not_entered");
			}),
		]);
		// Recover a real running queue record with a fresh handler and no in-memory Prepared.
		service = attach();
		assert((await queue.recover()) === 1, "expected_one_interrupted_job");
		const jobState = store.read((tx: typeof f.db) =>
			queue.getInTransaction(tx, interruptedJob),
		).state;
		const domain = store.read((tx: typeof f.db) =>
			service.get(tx, interruptedRef, auth),
		);
		const reserved = store.read((tx: typeof f.db) =>
			sqliteRepository.request(tx, interruptedRef)!,
		).usage.modelCalls;
		assert(
			jobState === "interrupted" &&
				domain.kind === "unavailable" &&
				domain.code === "backend_restarted" &&
				reserved === 1,
			"interruption_not_applied",
		);
		results.runningRecovery = {
			jobState,
			domainState: domain.kind,
			code: domain.code,
			reserved,
		};
	} finally {
		f.ports.inference.complete = previousComplete;
		release.resolve();
		await previousQueue.close();
	}
	assert(
		store.read((tx: typeof f.db) => service.get(tx, interruptedRef, auth))
			.kind === "unavailable",
		"late_response_changed_interrupted_request",
	);
	await store.write((tx: typeof f.db) =>
		service.forget(tx, [delivered.auditRef], 1),
	);
	assert(
		(
			await service.getSkillDelivery(
				requestRef,
				auth,
				(op) => store.read(op),
				new AbortController().signal,
			)
		).kind !== "ready",
		"revoked_bundle_delivered",
	);
	results.revocation =
		"previous completed artifact unavailable after revocation";
	const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: host });
	const record = {
		complete: true,
		eumenesSnapshot: new TextDecoder().decode(git.stdout).trim(),
		productNetworkCalls: 0,
		paidLlmCalls: 0,
		fixtureInferenceCalls: f.modelCalls(),
		results,
		scope:
			"Real public queue and SqliteStore implementations in an isolated temporary DB; inference/registry/policy/identity attestations are fixed test ports. Not production deployment or a real host inference/source-API benchmark.",
	};
	writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
	console.log(JSON.stringify(record));
} finally {
	await queue!.close();
	await store.close();
	f.dispose();
	rmSync(dir, { recursive: true, force: true });
}
