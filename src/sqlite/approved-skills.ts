import type { Database } from "bun:sqlite";
import {
	approvedSkillSchema,
	type ApprovedSkillStore,
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
	return {
		...approval,
		get(db, ref) {
			const row = db
				.query("SELECT data_json FROM knowledge_approved_skills WHERE ref=?")
				.get(ref) as { data_json: string } | null;
			return row ? parse(row) : null;
		},
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
