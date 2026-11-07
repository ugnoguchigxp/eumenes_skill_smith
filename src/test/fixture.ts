import { Database } from "bun:sqlite";
import { afterEach } from "bun:test";
const databases: Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
import { createSkillSmith } from "../index.js";
import { migrations, sqliteRepository } from "../sqlite/index.js";
import type {
	Authority,
	Decision,
	Evidence,
	GuidanceRequest,
	VersionRef,
} from "../index.js";
import type { Ports } from "../contracts/ports.js";
export function fixture(
	options: {
		external?: boolean;
		parent?: boolean;
		path?: string;
		existing?: boolean;
		assemblyMode?: Ports<Database>["assemblyMode"];
	} = {},
) {
	const db = new Database(options.path ?? ":memory:");
	databases.push(db);
	if (!options.existing) for (const m of migrations) db.exec(m.sql);
	db.exec(
		"CREATE TABLE IF NOT EXISTS fixture_jobs(id TEXT PRIMARY KEY,request_ref TEXT,epoch INTEGER,cancelled INTEGER DEFAULT 0)",
	);
	let at = 1000000,
		modelCalls = 0,
		valid = true,
		receipts = true,
		sourceValid = true,
		policyValid = true;
	const ref: VersionRef = {
		id: "policy",
		version: "1",
		digest: "digest",
		generation: 0,
	};
	const auth: Authority = {
		scope: "owner",
		principal: "user",
		epoch: 0,
		sourceRefs: ["message:1"],
		permissions: ["build", "report", "manage"],
		...(options.parent ? { parentRef: "parent:1" } : {}),
		...(options.external ? { searchTask: "資料を整理する手順" } : {}),
	};
	const request: GuidanceRequest = {
		contractVersion: "skillsmith.v1",
		requestId: "request:1",
		task: {
			goal: "資料の相違を確認して報告する",
			acceptance: [{ id: "acceptance:1", text: "差異と出所が説明されている" }],
			constraints: [{ id: "constraint:1", text: "原資料を変更しない" }],
			references: [],
		},
		audience: "worker",
		environment: {
			id: "fixture",
			capabilities: [{ ...ref, id: "read" }],
			policy: ref,
		},
		limits: {
			deadlineAt: at + 120000,
			modelCalls: 2,
			sourceCalls: 8,
			candidates: 8,
			documents: 4,
			inputBytes: 32768,
			outputBytes: 16384,
			outputTokens: 1200,
		},
	};
	let evidence: Evidence[] = [
		{
			ref: "skill:compare@1",
			version: { ...ref, id: "compare" },
			title: "比較",
			body: "資料の正本を確認し、差異の根拠を対応付ける。",
			sections: [
				{ id: "inspect", body: "資料の正本を確認する。" },
				{ id: "compare", body: "差異と出所を対応付ける。" },
			],
			status: "active",
			complete: true,
			external: false,
			scope: "shared",
		},
	];
	let decision: Decision = {
		kind: "ready",
		strategy: "compose",
		sourceRefs: ["skill:compare@1"],
		sections: [
			{ id: "start", body: "資料の正本と相違を確認する。" },
			{ id: "finish", body: "不確実な箇所を示し、報告を検証する。" },
		],
		patches: [],
		requiredCapabilities: ["read"],
		verification: ["差異の各項目が原資料へたどれるか確認する。"],
		assumptions: [],
	};
	let output: unknown = null;
	const ports: Ports<Database> = {
		assemblyMode: options.assemblyMode ?? "legacy",
		repository: sqliteRepository,
		authority: {
			valid: (_tx, _a, refs) =>
				valid && refs.every((r) => !sqliteRepository.blocked(db, r)),
		},
		registry: {
			search: async () => structuredClone(evidence),
			read: async (ref) =>
				structuredClone(evidence.find((e) => e.ref === ref)!),
			current: () => valid,
		},
		inference: {
			complete: async () => {
				modelCalls++;
				return {
					value: output ?? structuredClone(decision),
					receipt: "receipt",
					inputTokens: 20,
					outputTokens: 30,
				};
			},
			validReceipt: () => receipts,
		},
		policy: {
			resolve: () => ({
				version: ref,
				body: "権限と元の受入条件を保ち、必要な根拠で検証する。",
				alreadyPresent: true,
			}),
			current: () => policyValid,
		},
		jobs: {
			enqueue(tx, job) {
				const id = "job:" + crypto.randomUUID();
				tx.query(
					"INSERT INTO fixture_jobs(id,request_ref,epoch) VALUES(?,?,?)",
				).run(id, job.requestRef, job.epoch);
				return id;
			},
			cancel(tx, id) {
				tx.query("UPDATE fixture_jobs SET cancelled=1 WHERE id=?").run(id);
			},
		},
		now: () => at,
		id: () => "ref:" + crypto.randomUUID(),
		...(options.external
			? {
					source: {
						search: async () => ({
							cards: [
								(({ body: _b, sections: _s, ...card }) => ({
									...card,
									ref: "external:1",
									external: true,
								}))(evidence[0]!),
							],
							warnings: [],
							degraded: [],
							truncated: false,
						}),
						get: async () => ({
							...evidence[0]!,
							ref: "external:1",
							external: true,
						}),
						validate: async () => sourceValid,
					},
				}
			: {}),
	};
	const service = createSkillSmith(ports);
	const write = <T>(op: () => T) => db.transaction(op)();
	const read = <T>(op: (tx: Database) => T) => op(db);
	function submit(r = request, a = auth) {
		return write(() => service.submit(db, r, a));
	}
	async function run(refId: string, a = auth) {
		const row = sqliteRepository.request(db, refId)!;
		const prepared = write(() => service.prepare(db, refId, row.epoch, a));
		if (!prepared) throw new Error("not_prepared");
		const result = await service.execute(prepared, {
			signal: new AbortController().signal,
			reserve: async (kind) => {
				write(() => service.reserve(db, prepared, kind, a));
			},
			noteUsage: async (observed) => {
				write(() =>
					service.noteUsage(db, prepared, a, {
						inputTokens: observed.inputTokens,
						outputTokens: observed.outputTokens,
						reasoningTokens: observed.reasoningTokens,
						cachedInputTokens: observed.cachedInputTokens,
					}),
				);
			},
		});
		return {
			prepared,
			result,
			settle: () => write(() => service.settle(db, prepared, result, a)),
		};
	}
	return {
		db,
		auth,
		request,
		ports,
		service,
		write,
		read,
		submit,
		run,
		dispose: () => {
			databases.splice(databases.indexOf(db), 1);
			db.close();
		},
		advance: (ms: number) => {
			at += ms;
		},
		setEvidence: (e: Evidence[]) => {
			evidence = e;
		},
		setDecision: (d: Decision) => {
			decision = d;
		},
		setOutput: (v: unknown) => {
			output = v;
		},
		setValid: (v: boolean) => {
			valid = v;
		},
		setReceipts: (v: boolean) => {
			receipts = v;
		},
		setSourceValid: (v: boolean) => {
			sourceValid = v;
		},
		setPolicyValid: (v: boolean) => {
			policyValid = v;
		},
		modelCalls: () => modelCalls,
	};
}
export type Fixture = ReturnType<typeof fixture>;
export async function ready(f: Fixture) {
	const receipt = f.submit();
	if (receipt.kind !== "pending" || !receipt.requestRef)
		throw new Error("expected_pending");
	const work = await f.run(receipt.requestRef);
	work.settle();
	const reply = await f.service.getValidated(
		receipt.requestRef,
		f.auth,
		f.read,
		new AbortController().signal,
	);
	if (reply.kind !== "ready") throw new Error("expected_ready:" + reply.kind);
	return { reply, work, requestRef: receipt.requestRef, build: reply.build };
}
