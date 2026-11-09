/** Run the public Eumenes settings, inference, queue and store on an isolated database. */
import "../../scripts/test-preload.js";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fixture } from "../../src/test/fixture-host.js";
import {
	createBuildJobHandler,
	createBuildQueueJobs,
	createEumenesInference,
	createSkillSmith,
	type ReadyDecision,
} from "../../src/index.js";
import { migrations, sqliteRepository } from "../../src/sqlite/index.js";

const host = resolve(process.argv[2] ?? "../eumenes");
const out = resolve(
	process.argv[3] ?? "artifacts/eumenes-inference-delivery.json",
);
const load = (path: string) =>
	import(pathToFileURL(join(host, "api", path)).href);
const [hostStore, hostSettings, hostInference, hostQueue] = await Promise.all([
	load("infrastructure/sqlite/index.ts"),
	load("domains/settings/index.ts"),
	load("domains/inference/index.ts"),
	load("domains/queue/index.ts"),
]);
const f = fixture();
type Tx = typeof f.db;
function check(condition: unknown, code: string): asserts condition {
	if (!condition) throw Error(code);
}
const directory = realpathSync(
	mkdtempSync(join(tmpdir(), "smith-inference-host-")),
);
const dbPath = join(directory, "test.sqlite");
const store = hostStore.openStore(dbPath, [
	...hostSettings.migrations,
	...hostInference.migrations,
	...hostQueue.migrations,
	...migrations,
]);
let inference:
	Awaited<ReturnType<typeof hostInference.createInference>> | undefined;
let queue: Awaited<ReturnType<typeof hostQueue.createQueue>> | undefined;
try {
	const settings = await hostSettings.createSettings(store, {
		dbPath,
		env: {},
	});
	const config = settings.get();
	const connectionId = crypto.randomUUID();
	const resourceId = crypto.randomUUID();
	config.connections.push({
		id: connectionId,
		name: "Fixture",
		baseUrl: "http://127.0.0.1:19999/v1",
		enabled: true,
		epoch: 0,
		envRef: null,
	});
	config.resources.push({
		id: resourceId,
		connectionId,
		purpose: "llm",
		model: "fixture-llm",
		contextWindow: 32_768,
		voice: null,
	});
	Object.assign(config.routes.llm, {
		mode: "cloud-only",
		cloudAllowed: true,
		fallbackId: resourceId,
	});
	await settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: config.revision,
		settings: config,
		keys: [{ connectionId, value: "fixture-key" }],
	});

	const draft: ReadyDecision = {
		kind: "ready",
		strategy: "reuse",
		sourceRefs: ["skill:compare@1"],
		sections: [],
		patches: [],
		requiredCapabilities: [],
		verification: ["各相違に原資料が対応する。"],
		assumptions: [],
		name: "check-document-differences",
		title: "資料の相違を確認する",
		description: "相違と正本を照合するときに使う。",
		language: "ja",
		localizedInstructions:
			"1. 正本を照合し、出所のない相違があれば報告を保留する。",
		sourceReview: {
			assessment: "対象資料の照合に適用する。",
			flaggedItems: [],
		},
		nonSourceAdditions: [],
		document: {
			sections: [
				{
					kind: "principles",
					heading: "原則",
					body: "正本に基づいて相違を扱う。",
				},
				{ kind: "workflow", heading: "手順" },
				{ kind: "completion", heading: "完了条件" },
			],
			references: [
				{
					path: "references/check.md",
					title: "合成照合例",
					content: "```python\nassert {'a'} - {'a'} == set()\n```",
				},
			],
			resourceHeading: "参照",
		},
	};
	const responses = [
		draft,
		{ approved: true, reason: "正本の照合と保留条件を確認した。" },
	];
	let transportCalls = 0;
	inference = hostInference.createInference(store, settings, {
		fetch: async (url: URL | Request | string) => {
			check(
				String(url).startsWith("http://127.0.0.1:19999/v1/"),
				"unexpected_transport",
			);
			const next = responses[transportCalls++];
			check(next, "extra_model_call");
			return Response.json({
				choices: [{ message: { content: JSON.stringify(next) } }],
				usage: { prompt_tokens: 70, completion_tokens: 30 },
			});
		},
		larmFactory: () => ({
			status: () => ({ state: "unconfigured", capabilities: [] }),
			answer: async () => {
				throw Error("unexpected_local_model");
			},
			close: async () => {},
		}),
	});
	queue = hostQueue.createQueue(store);
	const port = createEumenesInference<Tx>({
		control: inference,
		read: (operation) => store.read(operation),
		write: (operation) => store.write(operation),
	});
	let lastReceipt: string | undefined;
	const service = createSkillSmith<Tx>({
		...f.ports,
		now: Date.now,
		assemblyMode: "lean",
		inference: {
			...port,
			async complete(input, signal) {
				const answer = await port.complete(input, signal);
				lastReceipt = answer.receipt;
				return answer;
			},
		},
		jobs: createBuildQueueJobs<Tx>(queue),
		authority: {
			valid: (tx, auth, refs) =>
				auth.scope === f.auth.scope &&
				auth.principal === f.auth.principal &&
				auth.epoch === f.auth.epoch &&
				refs.every((ref) => !sqliteRepository.blocked(tx, ref)),
		},
	});
	queue.registerHandler(
		createBuildJobHandler<Tx>({
			service,
			write: (operation) => store.write(operation),
			authorityFor: (tx, ref) =>
				sqliteRepository.request(tx, ref)?.authority ?? null,
		}),
	);
	f.request.limits.deadlineAt = Date.now() + 25_000;
	const pending = await store.write((tx: Tx) =>
		service.submitArtifact(tx, f.request, f.auth),
	);
	check(
		pending.kind === "pending" && pending.requestRef,
		"request_not_pending",
	);
	const ref = pending.requestRef;
	const jobRef = store.read(
		(tx: Tx) => sqliteRepository.request(tx, ref)!.jobRef!,
	);
	let jobState: string | undefined;
	for (let i = 0; i < 200; i++) {
		await queue.tick();
		jobState = store.read(
			(tx: Tx) => queue!.getInTransaction(tx, jobRef)?.state,
		);
		if (jobState !== "queued" && jobState !== "running") break;
		await Bun.sleep(10);
	}
	check(jobState === "completed", "host_job_not_completed:" + jobState);
	const packet = await service.getSkillDelivery(
		ref,
		f.auth,
		(op) => store.read(op),
		AbortSignal.timeout(2000),
	);
	check(
		packet.kind === "ready" && packet.skill.files?.length === 1,
		"host_delivery_missing_bundle",
	);
	const row = store.read((tx: Tx) => sqliteRepository.request(tx, ref)!);
	check(
		transportCalls === 2 &&
			row.usage.inputTokens === 140 &&
			row.usage.outputTokens === 60,
		"host_usage_mismatch",
	);
	check(row.outcome?.kind === "ready", "host_request_not_ready");
	const token = lastReceipt;
	check(typeof token === "string", "host_receipt_missing");
	check(
		store.read((tx: Tx) => port.validReceipt(tx, token, ref)),
		"host_receipt_not_valid",
	);
	check(
		!store.read((tx: Tx) => port.validReceipt(tx, token, "other-request")),
		"host_cross_request_receipt",
	);
	const [requestId] = JSON.parse(token) as [string, string];
	await store.write((tx: Tx) =>
		inference!.cancelRequestsInTransaction(tx, [requestId]),
	);
	check(
		!store.read((tx: Tx) => port.validReceipt(tx, token, ref)),
		"host_revoked_receipt_still_valid",
	);
	const result = {
		hostCommit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: host })
			.stdout.toString()
			.trim(),
		queueState: jobState,
		delivery: packet.kind,
		bundleDigest: packet.skill.bundleDigest,
		usage: row.usage,
		transportCalls,
		crossRequestReceiptRefused: true,
		revokedReceiptRefused: true,
		provider: "injected fixed responses in actual host inference transport",
	};
	writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
	console.log(JSON.stringify(result));
} finally {
	await queue?.close();
	await inference?.close();
	await store.close();
	f.dispose();
	rmSync(directory, { recursive: true, force: true });
}
