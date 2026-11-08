/** Isolated offline countercheck: exact-task cache reuse versus a paraphrased goal. */
import { resolve, join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
const root = resolve(process.argv[2] ?? process.cwd());
await import(root + "/scripts/test-preload.ts");
const { recordedInference } = await import(
	root + "/examples/contextstill/recorded.ts"
);
const { createExampleHost } = await import(
	root + "/examples/contextstill/host.ts"
);
const { ContextStillFixture } = await import(
	root + "/examples/contextstill/database.ts"
);
const { createFixtureSource } = await import(
	root + "/examples/contextstill/source.ts"
);
const { createMcpHandler } = await import(
	root + "/examples/contextstill/mcp.ts"
);
const { createAutoReformulatingSource, createReformulatingSource } =
	await import(root + "/examples/contextstill/query-reformulation.ts");
const { seedDatabase } = await import(root + "/examples/contextstill/seed.ts");
const { sqliteRepository } = await import(root + "/src/sqlite/index.ts");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const suite = read(root + "/docs/quality/novel-three-suite-2026-11-08.json");
const config = read(root + "/docs/quality/cloud-eval-generation-settings.json");
const records = read(root + "/artifacts/novel-three-2026-11-08/records.json");
const task = suite.tasks.find((t) => t.id === "asciidoc-opaque-roundtrip");
const temp = mkdtempSync(join(tmpdir(), "skillsmith-cache-probe-"));
let modelInvocations = 0;
const port = (sample, model) => {
	const replay = recordedInference(
		records.filter((r) => r.taskId === task.id),
		() => {},
		undefined,
		{
			providerSettings: {
				provider: "saved-cloud-responses",
				model: model.id,
				generation: {
					adapter: "strict-schema.v4",
					sample,
					reasoningEffort: model.reasoningEffort ?? null,
				},
			},
		},
	);
	return {
		validReceipt: replay.validReceipt,
		complete: async (...args) => {
			modelInvocations++;
			return replay.complete(...args);
		},
	};
};
function assert(ok, message) {
	if (!ok) throw Error(message);
}
try {
	const dbPath = join(temp, "seed.sqlite");
	seedDatabase({ destination: dbPath });
	const fixture = new ContextStillFixture(dbPath, "bm25");
	try {
		const token = "offline-cache-probe";
		const plain = createFixtureSource(createMcpHandler(fixture, token), token);
		const source = createAutoReformulatingSource(
			plain,
			createReformulatingSource(plain, port("reformulation", config.executor), {
				deadlineAt: 1_700_000_120_000,
			}),
		);
		const host = createExampleHost(
			source,
			task.goal,
			port("quality-build", config.builder),
			{
				goal: task.goal,
				acceptance: task.acceptance,
				requestId: "scenario:" + task.id,
				modelCalls: 4,
				candidates: 8,
				documents: 8,
				outputTokens: 4000,
				constraints: config.taskConstraints,
				assemblyMode: "baseline",
			},
		);
		try {
			const original = await host.run();
			assert(original.kind === "ready", "initial_replay_failed");
			const replayInvocations = modelInvocations;
			const durations = [],
				sourceCounts = [];
			const iterations = 200,
				warmup = 10;
			for (let i = 0; i < iterations + warmup; i++) {
				const start = performance.now(),
					before = host.callLedger.length;
				const request = {
					...structuredClone(host.request),
					requestId: "cache-probe:" + i,
				};
				const result = host.db.transaction(() =>
					host.service.submit(host.db, request, host.authority),
				)();
				const row = sqliteRepository.request(host.db, result.requestRef);
				assert(
					row?.outcome?.kind === "ready" && row.jobRef === null,
					"expected_exact_cache_hit",
				);
				const delivered = await host.service.getSkillValidated(
					result.requestRef,
					host.authority,
					(op) => op(host.db),
					new AbortController().signal,
					{
						signal: new AbortController().signal,
						reserve: async (kind) => {
							host.db.transaction(() =>
								host.service.reserveDelivery(
									host.db,
									result.requestRef,
									host.authority,
									kind,
								),
							)();
						},
						noteCall: (c) => host.callLedger.push(c),
					},
				);
				const durationMs = performance.now() - start;
				assert(
					delivered.kind === "ready" &&
						delivered.skill.bundleDigest === original.skill.bundleDigest,
					"cached_delivery_mismatch",
				);
				if (i >= warmup) {
					durations.push(durationMs);
					sourceCounts.push(
						host.callLedger
							.slice(before)
							.filter((c) => c.kind === "sourceCalls").length,
					);
				}
			}
			assert(
				modelInvocations === replayInvocations,
				"cache_must_not_call_model",
			);
			const paraphrased = structuredClone(host.request);
			paraphrased.requestId = "cache-probe:paraphrased";
			paraphrased.task.goal = task.goal.replace(
				"計画を作ってください",
				"計画を提案してください",
			);
			assert(paraphrased.task.goal !== task.goal, "paraphrase_required");
			const miss = host.db.transaction(() =>
				host.service.submit(host.db, paraphrased, host.authority),
			)();
			const missRow = sqliteRepository.request(host.db, miss.requestRef);
			assert(
				miss.kind === "pending" && missRow?.jobRef !== null,
				"paraphrased_goal_must_miss_exact_cache",
			);
			const sorted = [...durations].sort((a, b) => a - b);
			const report = {
				complete: true,
				networkCalls: 0,
				paidModelCalls: 0,
				initializationReplayModelInvocations: replayInvocations,
				measuredCacheModelInvocations: modelInvocations - replayInvocations,
				iterations,
				warmup,
				readyDeliveries: durations.length,
				minMs: sorted[0],
				medianMs: sorted[Math.ceil(sorted.length * 0.5) - 1],
				p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
				maxMs: sorted.at(-1),
				meanMs: durations.reduce((s, d) => s + d, 0) / durations.length,
				sourceValidationCalls: [...new Set(sourceCounts)],
				paraphrasedOutcome: miss.kind,
				paraphraseEnqueuedGeneration: missRow.jobRef !== null,
				timingSamplesMs: durations,
				scope:
					"Existing unchanged core; one AsciiDoc artifact; in-memory host SQLite and local public-fixture validation; fixed fixture clock. Not a remote Eumenes benchmark, not semantic applicability validation, and not the latency of fresh generation.",
			};
			writeFileSync(
				root + "/docs/quality/latency-review-2026-11-08/cache-probe.json",
				JSON.stringify(report, null, 2) + "\n",
			);
			console.log(JSON.stringify({ ...report, timingSamplesMs: undefined }));
		} finally {
			host.close();
		}
	} finally {
		fixture.close();
	}
} finally {
	rmSync(temp, { recursive: true, force: true });
}
