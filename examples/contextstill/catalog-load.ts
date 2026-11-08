/** Synthetic index/storage load only. These distractors are not newly generated or content-approved SKILLs. */
import type { Database } from "bun:sqlite";
import {
	digest,
	type ApprovedSkill,
	type ApprovedSkillStore,
} from "../../src/index.js";
import { publicationDigest } from "../../src/service/approved-publication.js";
import { sqliteRepository } from "../../src/sqlite/index.js";
export function addCatalogLoad(
	db: Database,
	store: ApprovedSkillStore<Database>,
	original: ApprovedSkill,
	from: number,
	to: number,
	approved: Set<string>,
) {
	const started = performance.now();
	db.transaction(() => {
		for (let i = from; i < to; i++) {
			const r = structuredClone(original);
			r.ref = "load-publication:" + i;
			r.approvalRef = "load-approval:" + i;
			r.applicability =
				"Synthetic distractor: CSS typography and responsive image layout. This is a storage/index workload, not newly evaluated content.";
			r.template.content.task.goal =
				"Synthetic CSS typography and responsive image layout record " + i;
			if (i % 2 === 0)
				r.template.content.environment.id = "load-environment:" + (i % 17);
			r.template.digest = digest(r.template.content);
			r.digest = publicationDigest(r);
			store.put(db, r);
			approved.add(r.digest);
			sqliteRepository.link(db, r.ref, r.template.ref);
			sqliteRepository.link(db, r.ref, r.approvalRef);
		}
	})();
	return { inserted: to - from, preparationMs: performance.now() - started };
}
