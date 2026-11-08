import type { Database } from "bun:sqlite";
import type { z } from "zod";
import type { Repository } from "../contracts/ports.js";
import {
	buildSchema,
	proposalSchema,
	reflectionSchema,
	reportRecordSchema,
	requestRecordSchema,
} from "../contracts/schema.js";
import type {
	Build,
	Delivery,
	Proposal,
	Report,
	RequestRecord,
	Reflection,
} from "../contracts/types.js";
import { requireThat, SkillSmithError } from "../service/identity.js";

const reportBuildKey =
	"CASE WHEN json_valid(data_json) THEN json_extract(data_json,'$.input.buildRef') END";
const proposalExecutionKey =
	"CASE WHEN json_valid(data_json) THEN json_extract(data_json,'$.executionRef') END";

export const migrations = [
	{
		id: "knowledge/0001-init",
		sql: `
CREATE TABLE knowledge_requests(ref TEXT PRIMARY KEY,scope TEXT NOT NULL,request_id TEXT NOT NULL,revision INTEGER NOT NULL,data_json TEXT NOT NULL,UNIQUE(scope,request_id));
CREATE TABLE knowledge_builds(ref TEXT PRIMARY KEY,scope TEXT NOT NULL,cache_key TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,data_json TEXT NOT NULL);
CREATE INDEX knowledge_cache ON knowledge_builds(scope,cache_key);
CREATE TABLE knowledge_dependencies(owner TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(owner,source));
CREATE INDEX knowledge_dependants ON knowledge_dependencies(source);
CREATE TABLE knowledge_revoked(ref TEXT PRIMARY KEY);
CREATE TABLE knowledge_uses(scope TEXT NOT NULL,build_ref TEXT NOT NULL,execution_ref TEXT NOT NULL,PRIMARY KEY(scope,build_ref,execution_ref));
CREATE TABLE knowledge_deliveries(id TEXT PRIMARY KEY,request_ref TEXT NOT NULL,scope TEXT NOT NULL,epoch INTEGER NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0);
CREATE TABLE knowledge_results(scope TEXT NOT NULL,execution_ref TEXT NOT NULL,revision INTEGER NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(scope,execution_ref));
CREATE TABLE knowledge_report_receipts(scope TEXT NOT NULL,report_id TEXT NOT NULL,digest TEXT NOT NULL,revision INTEGER NOT NULL,execution_ref TEXT NOT NULL,PRIMARY KEY(scope,report_id));
CREATE TABLE knowledge_reflections(ref TEXT PRIMARY KEY,scope TEXT NOT NULL,report_digest TEXT NOT NULL,revision INTEGER NOT NULL,data_json TEXT NOT NULL,UNIQUE(scope,report_digest));
CREATE TABLE knowledge_proposals(ref TEXT PRIMARY KEY,scope TEXT NOT NULL,revision INTEGER NOT NULL,data_json TEXT NOT NULL);
`,
	},
	{
		id: "knowledge/0002-history-lookups",
		sql:
			[
				"CREATE INDEX IF NOT EXISTS knowledge_results_build ON knowledge_results(scope," +
					reportBuildKey +
					",execution_ref)",
				"CREATE INDEX IF NOT EXISTS knowledge_proposals_execution ON knowledge_proposals(scope," +
					proposalExecutionKey +
					")",
			].join(";\n") + ";",
	},
] as const;
function parseStored<T>(raw: string, schema: z.ZodType<T>): T {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new SkillSmithError("corrupt_storage");
	}
	const parsed = schema.safeParse(value);
	requireThat(parsed.success, "corrupt_storage");
	return parsed.data;
}
function json<T>(
	db: Database,
	sql: string,
	schema: z.ZodType<T>,
	...args: string[]
): T | null {
	const r = db.query(sql).get(...args) as { data_json: string } | null;
	return r ? parseStored(r.data_json, schema) : null;
}
export function blocked(db: Database, ref: string): boolean {
	return !!db
		.query(
			`
WITH RECURSIVE ancestry(ref) AS (
 SELECT ? UNION SELECT d.source FROM knowledge_dependencies d JOIN ancestry a ON d.owner=a.ref
) SELECT 1 FROM ancestry a JOIN knowledge_revoked r ON r.ref=a.ref LIMIT 1
`,
		)
		.get(ref);
}
export const sqliteRepository: Repository<Database> = {
	blocked,
	reflection: (db, ref) =>
		json<Reflection>(
			db,
			"SELECT data_json FROM knowledge_reflections WHERE ref=?",
			reflectionSchema,
			ref,
		),
	reflectionByReport: (db, scope, hash) =>
		json<Reflection>(
			db,
			"SELECT data_json FROM knowledge_reflections WHERE scope=? AND report_digest=?",
			reflectionSchema,
			scope,
			hash,
		),
	putReflection(db, row, expected) {
		requireThat(!blocked(db, row.ref), "reference_revoked");
		if (expected === null)
			db.query("INSERT INTO knowledge_reflections VALUES(?,?,?,?,?)").run(
				row.ref,
				row.scope,
				row.reportDigest,
				row.revision,
				JSON.stringify(row),
			);
		else
			requireThat(
				db
					.query(
						"UPDATE knowledge_reflections SET revision=?,data_json=? WHERE ref=? AND revision=?",
					)
					.run(row.revision, JSON.stringify(row), row.ref, expected).changes ===
					1,
				"reflection_conflict",
			);
	},
	request: (db, ref) =>
		json<RequestRecord>(
			db,
			"SELECT data_json FROM knowledge_requests WHERE ref=?",
			requestRecordSchema,
			ref,
		),
	requestByKey: (db, scope, id) =>
		json<RequestRecord>(
			db,
			"SELECT data_json FROM knowledge_requests WHERE scope=? AND request_id=?",
			requestRecordSchema,
			scope,
			id,
		),
	putRequest(db, row, expected) {
		requireThat(!blocked(db, row.ref), "reference_revoked");
		const data = JSON.stringify(row);
		if (expected === null)
			db.query("INSERT INTO knowledge_requests VALUES(?,?,?,?,?)").run(
				row.ref,
				row.authority.scope,
				row.request.requestId,
				row.revision,
				data,
			);
		else
			requireThat(
				db
					.query(
						"UPDATE knowledge_requests SET revision=?,data_json=? WHERE ref=? AND revision=?",
					)
					.run(row.revision, data, row.ref, expected).changes === 1,
				"request_conflict",
			);
	},
	openRequests(db, limit) {
		return (
			db
				.query(
					"SELECT data_json FROM knowledge_requests WHERE json_extract(data_json,'$.outcome') IS NULL ORDER BY rowid LIMIT ?",
				)
				.all(limit) as { data_json: string }[]
		).map((r) => parseStored(r.data_json, requestRecordSchema));
	},
	build(db, ref) {
		const b = json<Build>(
			db,
			"SELECT data_json FROM knowledge_builds WHERE ref=?",
			buildSchema,
			ref,
		);
		return b ? { ...b, revoked: blocked(db, ref) } : null;
	},
	cached(db, scope, key) {
		const rows = db
			.query(
				"SELECT ref,data_json FROM knowledge_builds WHERE scope=? AND cache_key=? AND revoked=0 ORDER BY rowid DESC",
			)
			.all(scope, key) as { ref: string; data_json: string }[];
		const r = rows.find((x) => !blocked(db, x.ref));
		return r ? parseStored(r.data_json, buildSchema) : null;
	},
	putBuild(db, b) {
		requireThat(!blocked(db, b.ref), "reference_revoked");
		db.query("INSERT INTO knowledge_builds VALUES(?,?,?,?,?)").run(
			b.ref,
			b.scope,
			b.key,
			0,
			JSON.stringify(b),
		);
	},
	revokeBuild(db, ref) {
		db.query("INSERT OR IGNORE INTO knowledge_revoked VALUES(?)").run(ref);
		db.query("UPDATE knowledge_builds SET revoked=1 WHERE ref=?").run(ref);
	},
	link(db, owner, source) {
		db.query("INSERT OR IGNORE INTO knowledge_dependencies VALUES(?,?)").run(
			owner,
			source,
		);
	},
	dependants: (db, ref) =>
		(
			db
				.query("SELECT owner FROM knowledge_dependencies WHERE source=?")
				.all(ref) as { owner: string }[]
		).map((r) => r.owner),
	erase(db, ref) {
		db.query("INSERT OR IGNORE INTO knowledge_revoked VALUES(?)").run(ref);
		db.query("DELETE FROM knowledge_requests WHERE ref=?").run(ref);
		db.query("DELETE FROM knowledge_builds WHERE ref=?").run(ref);
		db.query("DELETE FROM knowledge_proposals WHERE ref=?").run(ref);
		db.query("DELETE FROM knowledge_reflections WHERE ref=?").run(ref);
		const executions = db
			.query("SELECT scope,execution_ref FROM knowledge_uses WHERE build_ref=?")
			.all(ref) as { scope: string; execution_ref: string }[];
		for (const e of executions) {
			db.query(
				"DELETE FROM knowledge_results WHERE scope=? AND execution_ref=?",
			).run(e.scope, e.execution_ref);
			db.query(
				"DELETE FROM knowledge_report_receipts WHERE scope=? AND execution_ref=?",
			).run(e.scope, e.execution_ref);
		}
		db.query("DELETE FROM knowledge_uses WHERE build_ref=?").run(ref);
		db.query("DELETE FROM knowledge_deliveries WHERE request_ref=?").run(ref);
		db.query("DELETE FROM knowledge_dependencies WHERE owner=?").run(ref);
	},
	bindUse(db, scope, build, execution) {
		db.query("INSERT OR IGNORE INTO knowledge_uses VALUES(?,?,?)").run(
			scope,
			build,
			execution,
		);
	},
	hasUse: (db, scope, build, execution) =>
		!!db
			.query(
				"SELECT 1 FROM knowledge_uses WHERE scope=? AND build_ref=? AND execution_ref=?",
			)
			.get(scope, build, execution),
	putDelivery(db, d) {
		db.query(
			"INSERT INTO knowledge_deliveries VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
		).run(d.id, d.requestRef, d.scope, d.epoch, Number(d.acknowledged));
	},
	deliveries: (db, limit) =>
		(
			db
				.query(
					"SELECT id,request_ref,scope,epoch,acknowledged FROM knowledge_deliveries WHERE acknowledged=0 LIMIT ?",
				)
				.all(limit) as {
				id: string;
				request_ref: string;
				scope: string;
				epoch: number;
				acknowledged: number;
			}[]
		).map(
			(r) =>
				({
					id: r.id,
					requestRef: r.request_ref,
					scope: r.scope,
					epoch: r.epoch,
					acknowledged: !!r.acknowledged,
				}) satisfies Delivery,
		),
	ackDelivery(db, id) {
		db.query("UPDATE knowledge_deliveries SET acknowledged=1 WHERE id=?").run(
			id,
		);
	},
	report: (db, scope, execution) =>
		json<Report>(
			db,
			"SELECT data_json FROM knowledge_results WHERE scope=? AND execution_ref=?",
			reportRecordSchema,
			scope,
			execution,
		),
	reportReceipt(db, scope, id) {
		return db
			.query(
				"SELECT digest,revision FROM knowledge_report_receipts WHERE scope=? AND report_id=?",
			)
			.get(scope, id) as { digest: string; revision: number } | null;
	},
	putReport(db, r) {
		db.query(
			"INSERT INTO knowledge_results VALUES(?,?,?,?) ON CONFLICT(scope,execution_ref) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json",
		).run(r.scope, r.input.executionRef, r.revision, JSON.stringify(r));
		db.query("INSERT INTO knowledge_report_receipts VALUES(?,?,?,?,?)").run(
			r.scope,
			r.input.reportId,
			r.digest,
			r.revision,
			r.input.executionRef,
		);
	},
	reportsByBuild(db, scope, buildRef) {
		const rows = db
			.query(
				"SELECT data_json FROM knowledge_results WHERE scope=? AND " +
					reportBuildKey +
					"=? ORDER BY execution_ref",
			)
			.all(scope, buildRef) as { data_json: string }[];
		return rows.map((row) => parseStored(row.data_json, reportRecordSchema));
	},
	proposal: (db, ref) =>
		json<Proposal>(
			db,
			"SELECT data_json FROM knowledge_proposals WHERE ref=?",
			proposalSchema,
			ref,
		),
	proposalsByExecution(db, scope, executionRef) {
		const rows = db
			.query(
				"SELECT data_json FROM knowledge_proposals WHERE scope=? AND " +
					proposalExecutionKey +
					"=? ORDER BY rowid",
			)
			.all(scope, executionRef) as { data_json: string }[];
		return rows.map((row) => parseStored(row.data_json, proposalSchema));
	},
	putProposal(db, p, expected) {
		requireThat(!blocked(db, p.ref), "reference_revoked");
		if (expected === null)
			db.query("INSERT INTO knowledge_proposals VALUES(?,?,?,?)").run(
				p.ref,
				p.scope,
				p.revision,
				JSON.stringify(p),
			);
		else
			requireThat(
				db
					.query(
						"UPDATE knowledge_proposals SET revision=?,data_json=? WHERE ref=? AND revision=?",
					)
					.run(p.revision, JSON.stringify(p), p.ref, expected).changes === 1,
				"proposal_conflict",
			);
	},
};
