import type { Ports } from "../contracts/ports.js";
import type { Authority, GuidanceRequest } from "../contracts/types.js";
import type { ApprovedSkill } from "../contracts/approved-skills.js";
import { available, compatible } from "./approved-publication.js";
import { requireThat } from "./identity.js";
/** Bounded candidate construction; all applicability judgments stay in the selector. */
export function prepareApprovedCatalog<Tx>(
	p: Ports<Tx>,
	tx: Tx,
	request: GuidanceRequest,
	auth: Authority,
	scanLimit: number,
) {
	const candidates: ApprovedSkill[] = [];
	const store = p.approvedSkills;
	let scanned = 0,
		exhausted = true;
	if (store?.scan) {
		let cursor: string | undefined;
		const seen = new Set<string>();
		do {
			const pageSize = Math.min(32, scanLimit - scanned);
			requireThat(pageSize > 0, "catalog_scan_limit");
			const page = store.scan(tx, {
				scope: auth.scope,
				query: request.task.goal,
				environment: request.environment,
				audience: request.audience,
				now: p.now(),
				limit: pageSize,
				cursor,
			});
			requireThat(
				page.records.length <= pageSize &&
					(page.nextCursor === null ||
						(page.records.length > 0 && page.nextCursor !== cursor)),
				"catalog_contract_violation",
			);
			let consumed = 0;
			for (const record of page.records) {
				consumed++;
				requireThat(!seen.has(record.ref), "catalog_contract_violation");
				seen.add(record.ref);
				scanned++;
				if (available(p, tx, record, auth) && compatible(record, request))
					candidates.push(record);
				if (candidates.length === request.limits.candidates) break;
			}
			exhausted = page.nextCursor === null && consumed === page.records.length;
			if (
				page.nextCursor === null ||
				candidates.length === request.limits.candidates
			)
				break;
			cursor = page.nextCursor;
		} while (scanned < scanLimit);
		if (candidates.length < request.limits.candidates && !exhausted)
			requireThat(false, "catalog_scan_limit");
	} else if (store) {
		const records = store.list(tx, auth.scope, request.limits.candidates);
		scanned = records.length;
		exhausted = records.length < request.limits.candidates;
		candidates.push(
			...records.filter(
				(r) => available(p, tx, r, auth) && compatible(r, request),
			),
		);
		if (!candidates.length && !exhausted)
			requireThat(false, "catalog_scan_limit");
	}
	return { candidates, catalog: { scanned, exhausted } };
}
