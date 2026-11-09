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
		const wanted = request.limits.candidates;
		const rankedCandidates = Math.max(1, wanted - 2);
		const rankedScanLimit = Math.max(1, Math.floor(scanLimit / 2));
		let cursor: string | undefined;
		let structural = false;
		const seenRanked = new Set<string>();
		const seenInRange = new Set<string>();
		do {
			const pageSize = Math.min(32, scanLimit - scanned);
			requireThat(pageSize > 0, "catalog_scan_limit");
			const page = store.scan(tx, {
				scope: auth.scope,
				query: structural ? undefined : request.task.goal,
				environment: request.environment,
				audience: request.audience,
				now: p.now(),
				limit: pageSize,
				cursor,
			});
			requireThat(
				page.records.length <= pageSize &&
					(!structural || !page.ranked) &&
					(page.nextCursor === null ||
						(page.records.length > 0 && page.nextCursor !== cursor)),
				"catalog_contract_violation",
			);
			let consumed = 0;
			for (const record of page.records) {
				consumed++;
				requireThat(!seenInRange.has(record.ref), "catalog_contract_violation");
				seenInRange.add(record.ref);
				scanned++;
				if (page.ranked) seenRanked.add(record.ref);
				if (
					(!structural || !seenRanked.has(record.ref)) &&
					available(p, tx, record, auth) &&
					compatible(record, request)
				)
					candidates.push(record);
				if (
					candidates.length === wanted ||
					(page.ranked &&
						(candidates.length >= rankedCandidates ||
							scanned >= rankedScanLimit))
				)
					break;
			}
			exhausted =
				!page.ranked &&
				page.nextCursor === null &&
				consumed === page.records.length;
			if (candidates.length === wanted) break;
			if (
				page.ranked &&
				(page.nextCursor === null ||
					consumed < page.records.length ||
					candidates.length >= rankedCandidates ||
					scanned >= rankedScanLimit)
			) {
				structural = true;
				cursor = undefined;
				seenInRange.clear();
				continue;
			}
			if (page.nextCursor === null) break;
			cursor = page.nextCursor;
		} while (scanned < scanLimit);
		if (candidates.length < wanted && !exhausted)
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
