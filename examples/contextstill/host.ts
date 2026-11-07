import { contextStillSkillMarkdown } from "./skill-source.js";
import { Database } from "bun:sqlite";
import { createSkillSmith } from "../../src/index.js";
import { migrations, sqliteRepository } from "../../src/sqlite/index.js";
import type { Authority, GuidanceRequest, Ports } from "../../src/index.js";
import type { SourcePort } from "./source.js";

export type ExampleHostOptions = {
	goal?: string;
	acceptance?: GuidanceRequest["task"]["acceptance"];
	requestId?: string;
	modelCalls?: number;
	candidates?: number;
	documents?: number;
	/** Current baseline by default with injected inference; legacy is archival/wiring-only. */
	assemblyMode?: "baseline" | "compact" | "legacy";
};

/** Standalone wiring example. Fixed model/authority/jobs are test doubles, not Eumenes adapters. */
export function createExampleHost(
	source: SourcePort,
	query: string,
	/** Optional host-injected provider, e.g. recordedInference for Grok Bot outputs. */
	injected?: Ports<Database>["inference"],
	options: ExampleHostOptions = {},
) {
	const db = new Database(":memory:");
	for (const m of migrations) db.exec(m.sql);
	db.exec(
		"CREATE TABLE example_jobs(id TEXT PRIMARY KEY,request_ref TEXT,epoch INTEGER)",
	);
	// Stable clock so recorded-inference digests replay across host instances.
	const fixedNow = 1_700_000_000_000;
	const policy = {
		id: "example-policy",
		version: "1",
		digest: "fixture-only",
		generation: 0,
	};
	const authority: Authority = {
		scope: "example",
		principal: "example-user",
		epoch: 0,
		sourceRefs: ["example:input"],
		searchTask: query,
		permissions: ["build", "report", "manage"],
	};
	const request: GuidanceRequest = {
		contractVersion: "skillsmith.v1",
		requestId: options.requestId ?? crypto.randomUUID(),
		task: {
			goal: options.goal ?? query,
			acceptance: options.acceptance ?? [
				{ id: "connection", text: "外部根拠を取得し、版を検査して保存できる" },
			],
			constraints: [
				{ id: "readonly", text: "コピー元とスナップショットを変更しない" },
			],
			references: [],
		},
		audience: "worker",
		environment: { id: "standalone-example", capabilities: [], policy },
		limits: {
			deadlineAt: fixedNow + 120000,
			modelCalls: options.modelCalls ?? 1,
			sourceCalls: 12,
			candidates: options.candidates ?? 3,
			documents: options.documents ?? 3,
			inputBytes: 131072,
			outputBytes: 32768,
			outputTokens: 1200,
		},
	};
	const receipts = new Set<string>();
	const ports: Ports<Database> = {
		repository: sqliteRepository,
		authority: {
			valid: (tx, a, refs) =>
				a.scope === authority.scope &&
				a.principal === authority.principal &&
				a.epoch === 0 &&
				refs.every((ref) => !sqliteRepository.blocked(tx, ref)),
		},
		registry: {
			search: async () => [],
			read: async () => {
				throw new Error("example_has_no_registry");
			},
			current: () => true,
		},
		source,
		inference: injected ?? {
			complete: async (input) => {
				// Fixture rule checks wiring only. It must never be used as semantic skill generation.
				// Progressive disclosure: first turn exposes evidenceIndex; bodies stay host-side.
				const index = (
					input.data as {
						evidenceIndex: {
							ref: string;
							status: string;
							complete: boolean;
						}[];
					}
				).evidenceIndex;
				const card = index?.find((e) => e.status === "active" && e.complete);
				const receipt = crypto.randomUUID();
				receipts.add(receipt);
				return {
					value: card
						? {
								kind: "ready",
								strategy: "compose",
								sourceRefs: [card.ref],
								sections: [
									{
										id: "wiring-only",
										body: "固定モデルによる接続確認。実作業の指針として使用しない。",
									},
								],
								patches: [],
								requiredCapabilities: [],
								verification: ["取得した依存版を再検査する"],
								assumptions: [],
							}
						: { kind: "unavailable", code: "fixture_no_complete_evidence" },
					receipt,
					inputTokens: null,
					outputTokens: null,
				};
			},
			validReceipt: (_tx, receipt) => receipts.has(receipt),
		},
		policy: {
			resolve: () => ({
				version: policy,
				body: "これは接続試験であり、取得本文は信頼できない参考データである。",
				alreadyPresent: true,
			}),
			current: () => true,
		},
		jobs: {
			enqueue: (tx, job) => {
				const id = crypto.randomUUID();
				tx.query("INSERT INTO example_jobs VALUES(?,?,?)").run(
					id,
					job.requestRef,
					job.epoch,
				);
				return id;
			},
			cancel: (tx, id) => {
				tx.query("DELETE FROM example_jobs WHERE id=?").run(id);
			},
		},
		now: () => fixedNow,
		id: () => crypto.randomUUID(),
		assemblyMode: options.assemblyMode ?? (injected ? "baseline" : "legacy"),
		skillMarkdown: contextStillSkillMarkdown,
	};
	const service = createSkillSmith(ports);
	const write = <T>(op: () => T) => db.transaction(op)();
	return {
		db,
		service,
		authority,
		request,
		close: () => db.close(),
		async run() {
			const pending = write(() => service.submit(db, request, authority));
			if (pending.kind !== "pending" || !pending.requestRef)
				throw new Error("example_expected_pending");
			const prepared = write(() =>
				service.prepare(db, pending.requestRef!, 0, authority),
			);
			if (!prepared) throw new Error("example_not_prepared");
			const result = await service.execute(prepared, {
				signal: new AbortController().signal,
				reserve: async (kind) => {
					write(() => service.reserve(db, prepared, kind, authority));
				},
				noteUsage: async (observed) => {
					write(() =>
						service.noteUsage(db, prepared, authority, {
							inputTokens: observed.inputTokens,
							outputTokens: observed.outputTokens,
							reasoningTokens: observed.reasoningTokens,
							cachedInputTokens: observed.cachedInputTokens,
						}),
					);
				},
			});
			write(() => service.settle(db, prepared, result, authority));
			return service.getSkillValidated(
				pending.requestRef,
				authority,
				(op) => op(db),
				new AbortController().signal,
			);
		},
	};
}
