/** Evaluation fixture only: build an approved library from exact previously reviewed provider records. */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSkillSmith, type Ports } from "../../src/index.js";
import {
	migrations,
	sqliteRepository,
	sqliteApprovedSkills,
} from "../../src/sqlite/index.js";
import { ContextStillFixture } from "./database.js";
import { seedDatabase } from "./seed.js";
import { createFixtureSource } from "./source.js";
import { createMcpHandler } from "./mcp.js";
import {
	createAutoReformulatingSource,
	createReformulatingSource,
} from "./query-reformulation.js";
import { recordedInference } from "./recorded.js";
import { createExampleHost } from "./host.js";

export async function replayLibrary(
	root: string,
	directory: string,
	recordsPath?: string,
) {
	const json = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
	const suite = json("docs/quality/novel-three-suite-2026-11-08.json");
	const config = json("docs/quality/cloud-eval-generation-settings.json");
	const records = JSON.parse(
		readFileSync(
			recordsPath ??
				join(root, "artifacts/novel-three-2026-11-08/records.json"),
			"utf8",
		),
	);
	const seed = join(directory, "seed.sqlite");
	seedDatabase({ destination: seed });
	const fixture = new ContextStillFixture(seed, "bm25");
	const token = "replay-library-evaluation",
		plain = createFixtureSource(createMcpHandler(fixture, token), token);
	const db = new Database(join(directory, "library.sqlite"));
	db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
	for (const m of migrations) db.exec(m.sql);
	db.exec(
		"CREATE TABLE example_jobs(id TEXT PRIMARY KEY,request_ref TEXT,epoch INTEGER)",
	);
	const approvals = new Set<string>();
	const store = sqliteApprovedSkills({
		// Explicit evaluation approval only: these exact bodies already have semantic-review and code-fixture evidence.
		authorizePublication: (_tx, _auth, r) => {
			approvals.add(r.digest);
			return true;
		},
		approvalCurrent: (_tx, r) => approvals.has(r.digest),
	});
	const deliveries: unknown[] = [],
		publications: { taskId: string; ref: string; digest: string }[] = [];
	let ports: Ports<Database> | undefined,
		matched = 0;
	for (const task of suite.tasks) {
		const port = (
			sample: string,
			model: { id: string; reasoningEffort?: string },
		) =>
			recordedInference(
				records.filter((r: { taskId: string }) => r.taskId === task.id),
				() => {
					matched++;
				},
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
			const delivered = await host.runDelivery();
			if (delivered.kind !== "ready")
				throw Error(
					"single_copy_delivery_failed:" +
						task.id +
						":" +
						JSON.stringify(delivered),
				);
			const ref = delivered.requestRef;
			const row = sqliteRepository.request(host.db, ref)!;
			if (row.outcome?.kind !== "ready") throw Error("expected_stored_ready");
			const build = sqliteRepository.build(host.db, row.outcome.buildRef)!;
			deliveries.push({
				taskId: task.id,
				kind: delivered.kind,
				bytes: Buffer.byteLength(JSON.stringify(delivered)),
				limit: host.request.limits.outputBytes,
				bundleDigest: delivered.skill.bundleDigest,
			});
			db.transaction(() => {
				sqliteRepository.putRequest(
					db,
					sqliteRepository.request(host.db, ref)!,
					null,
				);
				sqliteRepository.putBuild(db, build);
				sqliteRepository.link(db, build.ref, row.ref);
				for (const r of [
					...row.authority.sourceRefs,
					...build.content.dependencies.map((d) => d.ref),
				])
					sqliteRepository.link(db, build.ref, r);
			})();
			ports = { ...host.ports, approvedSkills: store };
			const service = createSkillSmith(ports);
			const registered = db.transaction(() =>
				service.publishSkill(
					db,
					{
						buildRef: build.ref,
						applicability:
							"この元依頼の目的・受入条件と計画限定の制約を満たし、追加の手順や新しい具体APIの補完を必要としない依頼に適用する。",
						approvalRef: "evaluation-reviewed:" + task.id,
					},
					host.authority,
				),
			)();
			publications.push({ taskId: task.id, ...registered });
		} finally {
			host.close();
		}
	}
	if (!ports) throw Error("no_ports");
	return {
		db,
		ports,
		publications,
		deliveries,
		matchedReplayCalls: matched,
		close() {
			db.close();
			fixture.close();
		},
	};
}
