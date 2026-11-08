/** Constant JSON paths shared by the expression index and its predicates. No caller SQL. */
const field = (path: string) =>
	`CASE WHEN json_valid(data_json) THEN json_extract(data_json,'${path}') END`;
export const approvedFields = {
	environment: field("$.template.content.environment.id"),
	audience: field("$.template.content.audience"),
	policyId: field("$.template.content.environment.policy.id"),
	policyVersion: field("$.template.content.environment.policy.version"),
	policyDigest: field("$.template.content.environment.policy.digest"),
	policyGeneration: field("$.template.content.environment.policy.generation"),
	expiry: field("$.expiresAt"),
};
export const approvedCompatibilityIndex = `CREATE INDEX IF NOT EXISTS knowledge_approved_compat ON knowledge_approved_skills(scope,${Object.values(approvedFields).slice(0, 6).join(",")});`;
