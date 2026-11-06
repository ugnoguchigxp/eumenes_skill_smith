import { z } from "zod";
import { evalConditionSchema, type EvalTask } from "./task.js";

export type EvalSuiteLike = {
	id: string;
	tasks: EvalTask[];
	records: {
		taskId: string;
		condition: "none" | "agent_skills" | "skillsmith";
		records: { inputDigest: string; value: unknown; provider: string }[];
	}[];
};

const CONDITIONS = ["none", "agent_skills", "skillsmith"] as const;

export const evalAuditFindingSchema = z.strictObject({
	code: z.enum([
		"missing_condition",
		"duplicate_condition",
		"missing_record",
		"tampered_digest",
		"wrong_condition",
		"unequal_task_manifest",
	]),
	taskId: z.string().optional(),
	condition: evalConditionSchema.optional(),
	detail: z.string().min(1).max(512),
});
export type EvalAuditFinding = z.infer<typeof evalAuditFindingSchema>;

export const evalAuditReportSchema = z.strictObject({
	ok: z.boolean(),
	findings: z.array(evalAuditFindingSchema).max(256),
});
export type EvalAuditReport = z.infer<typeof evalAuditReportSchema>;

/** Shared A/B/C task fields that must not silently diverge across conditions. */
export function taskManifest(task: EvalTask) {
	return {
		id: task.id,
		goal: task.goal,
		acceptance: task.acceptance,
		constraints: task.constraints ?? [],
		expectedRefs: task.expectedRefs ?? [],
	};
}

/**
 * Negative audit for the eval kit itself: missing / duplicate / tamper must fail.
 * Does not invent quality scores. Digests are compared only when expectedDigests is supplied.
 */
export function auditEvalSuite(
	suite: EvalSuiteLike,
	options: {
		/** Map `${taskId}:${condition}` → expected inputDigest for the first record. */
		expectedDigests?: Record<string, string>;
		/** When true, every condition for every task must have at least one record. */
		requireRecords?: boolean;
	} = {},
): EvalAuditReport {
	const parsed = suite;
	const findings: EvalAuditFinding[] = [];
	const requireRecords = options.requireRecords ?? false;
	const expected = options.expectedDigests ?? {};

	for (const task of parsed.tasks) {
		const packs = parsed.records.filter((r) => r.taskId === task.id);
		for (const condition of CONDITIONS) {
			const matching = packs.filter((p) => p.condition === condition);
			if (matching.length === 0) {
				findings.push({
					code: "missing_condition",
					taskId: task.id,
					condition,
					detail: `condition ${condition} has no record pack`,
				});
				continue;
			}
			if (matching.length > 1) {
				findings.push({
					code: "duplicate_condition",
					taskId: task.id,
					condition,
					detail: `condition ${condition} appears ${matching.length} times`,
				});
			}
			const pack = matching[0]!;
			if (pack.condition !== condition) {
				findings.push({
					code: "wrong_condition",
					taskId: task.id,
					condition,
					detail: `pack condition ${pack.condition} mismatches requested ${condition}`,
				});
			}
			if (requireRecords && pack.records.length === 0) {
				findings.push({
					code: "missing_record",
					taskId: task.id,
					condition,
					detail: "record pack is empty",
				});
			}
			const key = `${task.id}:${condition}`;
			if (key in expected) {
				const want = expected[key]!;
				const got = pack.records[0]?.inputDigest;
				if (!got) {
					findings.push({
						code: "missing_record",
						taskId: task.id,
						condition,
						detail: "expected digest present but record missing",
					});
				} else if (got !== want) {
					findings.push({
						code: "tampered_digest",
						taskId: task.id,
						condition,
						detail: `inputDigest ${got} !== expected ${want}`,
					});
				}
			}
		}
		// Task manifest equality is structural: each condition runner must receive the same task object.
		// Unequal copies in suite.tasks are not possible (one task entry); runners that mutate per condition are audited by contract fixtures.
		const manifest = taskManifest(task);
		if (!manifest.goal || !manifest.acceptance.length) {
			findings.push({
				code: "unequal_task_manifest",
				taskId: task.id,
				detail: "task missing goal or acceptance",
			});
		}
	}

	return evalAuditReportSchema.parse({
		ok: findings.length === 0,
		findings,
	});
}

/**
 * Fail-closed helper for CLI and tests. Throws with finding codes when audit fails.
 */
export function assertEvalSuiteAudited(
	suite: EvalSuiteLike,
	options?: Parameters<typeof auditEvalSuite>[1],
): EvalAuditReport {
	const report = auditEvalSuite(suite, options);
	if (!report.ok) {
		const codes = report.findings.map((f) => f.code).join(",");
		throw new Error(`eval_suite_audit_failed:${codes}`);
	}
	return report;
}
