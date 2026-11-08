import type { Authority, RequestRecord } from "../contracts/types.js";
import type { Ports } from "../contracts/ports.js";

type Permission = Authority["permissions"][number];

/** Host-attested identity plus the immutable origin; permissions are action-specific. */
export function requestAuthorized<Tx>(
	p: Ports<Tx>,
	tx: Tx,
	row: RequestRecord,
	auth: Authority,
	permission: Permission,
	refs: string[] = [],
): boolean {
	return (
		auth.permissions.includes(permission) &&
		row.authority.scope === auth.scope &&
		row.authority.principal === auth.principal &&
		row.authority.epoch === auth.epoch &&
		!p.repository.blocked(tx, row.ref) &&
		p.authority.valid(tx, auth, [
			...new Set([...row.authority.sourceRefs, ...refs]),
		])
	);
}

/** Report/manage access never borrows build permission or trusts a scope-only use. */
export function executionAuthorized<Tx>(
	p: Ports<Tx>,
	tx: Tx,
	buildRef: string,
	executionRef: string,
	auth: Authority,
	permission: Permission,
	evidence: string[],
): boolean {
	const build = p.repository.build(tx, buildRef);
	if (!build || build.revoked || build.scope !== auth.scope) return false;
	const origin = p.repository.request(tx, build.requestRef);
	return (
		!!origin &&
		origin.outcome?.kind === "ready" &&
		origin.outcome.buildRef === buildRef &&
		!p.repository.blocked(tx, buildRef) &&
		p.repository.hasUse(tx, auth.scope, buildRef, executionRef) &&
		requestAuthorized(p, tx, origin, auth, permission, [
			buildRef,
			executionRef,
			...evidence,
		])
	);
}
