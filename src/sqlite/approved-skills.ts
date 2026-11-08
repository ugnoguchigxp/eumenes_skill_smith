import { approvedSearchQuery } from "./approved-search.js";
import { approvedFields as fields } from "./approved-query.js";
import type { Database } from "bun:sqlite";
import {
	approvedSkillSchema,
	type ApprovedSkillStore,
	type ApprovedSkillScan,
	type ApprovedSkillPage,
} from "../contracts/approved-skills.js";
import { requireThat } from "../service/identity.js";
/** Same host-owned transaction as requests, dependencies and builds; approvals stay owner-owned. */
export function sqliteApprovedSkills(
	approval: Pick<
		ApprovedSkillStore<Database>,
		"authorizePublication" | "approvalCurrent"
	>,
): ApprovedSkillStore<Database> {
	const parse = (raw: { data_json: string }) => {
		let value: unknown;
		try {
			value = JSON.parse(raw.data_json);
		} catch {
			requireThat(false, "corrupt_storage");
		}
		const r = approvedSkillSchema.safeParse(value);
		requireThat(r.success, "corrupt_storage");
		return r.data;
	};
	function scan(db: Database, query: ApprovedSkillScan): ApprovedSkillPage {
		requireThat(
			Number.isSafeInteger(query.limit) &&
				query.limit >= 1 &&
				query.limit <= 64,
			"invalid_scan_limit",
		);
		const search =
			query.cursor !== undefined && !query.cursor.startsWith("q:")
				? null
				: approvedSearchQuery(query.query);
		const offset = search && query.cursor ? Number(query.cursor.slice(2)) : 0;
		const before =
			!search && query.cursor ? Number(query.cursor) : Number.MAX_SAFE_INTEGER;
		requireThat(
			Number.isSafeInteger(before) &&
				before > 0 &&
				Number.isSafeInteger(offset) &&
				offset >= 0 &&
				offset <= 4096 &&
				(query.cursor === undefined ||
					(search
						? query.cursor === "q:" + offset
						: String(before) === query.cursor)),
			"invalid_scan_cursor",
		);
		const policy = query.environment.policy;
		const rows = db
			.query(
				`SELECT knowledge_approved_skills.rowid AS sequence,data_json FROM knowledge_approved_skills
${search ? "JOIN knowledge_approved_search ON knowledge_approved_search.rowid=knowledge_approved_skills.rowid" : ""}
WHERE ${search ? "knowledge_approved_search MATCH ? AND" : ""} scope=? AND ${fields.environment}=? AND ${fields.audience}=?
AND ${fields.policyId}=? AND ${fields.policyVersion}=? AND ${fields.policyDigest}=? AND ${fields.policyGeneration}=?
AND ${fields.expiry}>? AND knowledge_approved_skills.rowid<?
AND NOT EXISTS (
 SELECT 1 FROM json_each(data_json,'$.template.content.decision.requiredCapabilities') required
 WHERE NOT EXISTS (
  SELECT 1 FROM json_each(data_json,'$.template.content.environment.capabilities') original
  JOIN json_each(?) provided ON json_extract(provided.value,'$.id')=required.value
  WHERE json_extract(original.value,'$.id')=required.value
   AND json_extract(original.value,'$.id')=json_extract(provided.value,'$.id')
   AND json_extract(original.value,'$.version')=json_extract(provided.value,'$.version')
   AND json_extract(original.value,'$.digest')=json_extract(provided.value,'$.digest')
   AND json_extract(original.value,'$.generation')=json_extract(provided.value,'$.generation')
 ))
ORDER BY ${search ? "knowledge_approved_search.rank," : ""} knowledge_approved_skills.rowid DESC LIMIT ? OFFSET ?`,
			)
			.all(
				...(search ? [search] : []),
				query.scope,
				query.environment.id,
				query.audience,
				policy.id,
				policy.version,
				policy.digest,
				policy.generation,
				query.now,
				before,
				JSON.stringify(query.environment.capabilities),
				query.limit + 1,
				offset,
			) as { sequence: number; data_json: string }[];
		if (search && query.cursor === undefined && rows.length === 0)
			return scan(db, { ...query, query: undefined });
		const page = rows.slice(0, query.limit);
		return {
			records: page.map(parse),
			nextCursor:
				rows.length > query.limit
					? search
						? "q:" + (offset + page.length)
						: String(page.at(-1)!.sequence)
					: null,
		};
	}
	return {
		...approval,
		get(db, ref) {
			const row = db
				.query("SELECT data_json FROM knowledge_approved_skills WHERE ref=?")
				.get(ref) as { data_json: string } | null;
			return row ? parse(row) : null;
		},
		scan,
		list(db, scope, limit) {
			return (
				db
					.query(
						"SELECT data_json FROM knowledge_approved_skills WHERE scope=? ORDER BY rowid DESC LIMIT ?",
					)
					.all(scope, limit) as { data_json: string }[]
			).map(parse);
		},
		put(db, record) {
			approvedSkillSchema.parse(record);
			db.query("INSERT INTO knowledge_approved_skills VALUES(?,?,?)").run(
				record.ref,
				record.scope,
				JSON.stringify(record),
			);
		},
	};
}
