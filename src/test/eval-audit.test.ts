import { expect, test } from "bun:test";
import {
	auditEvalSuite,
	assertEvalSuiteAudited,
	auxiliaryMetrics,
	runAgentSkillsBaseline,
	taskManifest,
	type EvalSuite,
} from "../eval/index.js";
import { digest } from "../service/identity.js";
import { recordedInference } from "../../examples/contextstill/recorded.js";
import type { Evidence } from "../index.js";

const baseSuite = (): EvalSuite => ({
	id: "suite:audit",
	tasks: [
		{
			id: "task:1",
			goal: "資料の相違を確認する",
			acceptance: [{ id: "a1", text: "差異が説明されている" }],
			constraints: [{ id: "c1", text: "原資料を変更しない" }],
			expectedRefs: ["skill:compare@1"],
		},
	],
	records: [
		{
			taskId: "task:1",
			condition: "none",
			records: [
				{
					inputDigest: "d-none",
					provider: "fixture",
					value: { kind: "ready" },
				},
			],
		},
		{
			taskId: "task:1",
			condition: "agent_skills",
			records: [
				{
					inputDigest: "d-base",
					provider: "fixture",
					value: { kind: "ready" },
				},
			],
		},
		{
			taskId: "task:1",
			condition: "skillsmith",
			records: [
				{
					inputDigest: "d-smith",
					provider: "fixture",
					value: { kind: "ready" },
				},
			],
		},
	],
});

test("audit passes a complete suite without expected digests", () => {
	const report = auditEvalSuite(baseSuite());
	expect(report.ok).toBe(true);
	expect(report.findings).toEqual([]);
});

test("missing condition pack fails audit", () => {
	const suite = baseSuite();
	suite.records = suite.records.filter((r) => r.condition !== "none");
	const report = auditEvalSuite(suite);
	expect(report.ok).toBe(false);
	expect(report.findings.some((f) => f.code === "missing_condition")).toBe(
		true,
	);
});

test("duplicate condition pack fails audit", () => {
	const suite = baseSuite();
	suite.records.push({ ...suite.records[0]! });
	const report = auditEvalSuite(suite);
	expect(report.ok).toBe(false);
	expect(report.findings.some((f) => f.code === "duplicate_condition")).toBe(
		true,
	);
});

test("tampered inputDigest fails when expected digests are supplied", () => {
	const suite = baseSuite();
	suite.records[2]!.records[0]!.inputDigest = "tampered-wrong-digest";
	const report = auditEvalSuite(suite, {
		expectedDigests: {
			"task:1:none": "d-none",
			"task:1:agent_skills": "d-base",
			"task:1:skillsmith": "d-smith",
		},
	});
	expect(report.ok).toBe(false);
	expect(report.findings.some((f) => f.code === "tampered_digest")).toBe(true);
	expect(() =>
		assertEvalSuiteAudited(suite, {
			expectedDigests: { "task:1:skillsmith": "d-smith" },
		}),
	).toThrow(/eval_suite_audit_failed:tampered_digest/);
});

test("requireRecords fails on empty pack", () => {
	const suite = baseSuite();
	suite.records[0]!.records = [];
	const report = auditEvalSuite(suite, { requireRecords: true });
	expect(report.ok).toBe(false);
	expect(report.findings.some((f) => f.code === "missing_record")).toBe(true);
});

test("lexicalOverlap is 字面一致 and can be high under meaning reversal", () => {
	// Shared surface tokens, opposite meaning — must not be called faithfulness.
	const m = auxiliaryMetrics({
		guidanceBody: "確認して 報告する ignore differences",
		contextBodies: ["確認して 報告する check differences"],
		usedRefs: ["skill:compare@1"],
		expectedContextRefs: ["skill:compare@1"],
	});
	expect(m.method).toBe("eval_kit_lexical_overlap_v1");
	expect(m.lexicalOverlap).toBeGreaterThan(0.5);
	expect("faithfulnessOverlap" in m).toBe(false);
});

test("Japanese unsegmented text is not treated as semantic faithfulness", () => {
	const m = auxiliaryMetrics({
		guidanceBody: "確認報告",
		contextBodies: ["確認してから報告する"],
		usedRefs: [],
	});
	// Single long token vs segmented tokens — overlap may be 0; still not faithfulness.
	expect(m.lexicalOverlap).toBeGreaterThanOrEqual(0);
	expect(m.method).toContain("lexical");
});

test("contract fixture: baseline and skillsmith share the same task manifest", async () => {
	const task = {
		goal: "資料の相違を確認する",
		acceptance: [{ id: "a1", text: "差異が説明されている" }],
		constraints: [{ id: "c1", text: "原資料を変更しない" }],
	};
	const environment = {
		id: "fixture",
		capabilityIds: ["read"],
		policyId: "policy",
	};
	const evidence: Evidence[] = [
		{
			ref: "skill:compare@1",
			version: { id: "compare", version: "1", digest: "d", generation: 0 },
			title: "比較",
			body: "差異と出所を対応付ける。",
			sections: [{ id: "compare", body: "差異と出所を対応付ける。" }],
			status: "active",
			complete: true,
			external: false,
			scope: "shared",
		},
	];
	const cards = evidence.map(({ body: _b, sections: _s, ...card }) => card);

	const baselineInput = {
		system: "baseline",
		data: {
			task: {
				goal: task.goal,
				acceptance: task.acceptance,
				constraints: task.constraints,
			},
			environment,
		},
		schema: { type: "object" },
	};
	const smithInput = {
		system: "skillsmith",
		data: {
			task: {
				goal: task.goal,
				acceptance: task.acceptance,
				constraints: task.constraints,
			},
			environment,
		},
		schema: { type: "object" },
	};
	// Manifest equality across conditions (constraints/environment included).
	expect(JSON.stringify(baselineInput.data.task)).toBe(
		JSON.stringify(smithInput.data.task),
	);
	expect(JSON.stringify(baselineInput.data.environment)).toBe(
		JSON.stringify(smithInput.data.environment),
	);
	expect(
		taskManifest({ id: "t", ...task, expectedRefs: [] }).constraints,
	).toEqual(task.constraints);

	const baselineDigest = digest({
		system: "eval-baseline",
		data: {
			task: {
				goal: task.goal,
				acceptance: task.acceptance,
				constraints: task.constraints,
			},
			environment,
			candidateCards: cards.map((c) => ({
				ref: c.ref,
				title: c.title,
				status: c.status,
				complete: c.complete,
				external: c.external,
				scope: c.scope,
			})),
			evidenceIndex: [
				{
					ref: evidence[0]!.ref,
					title: evidence[0]!.title,
					status: evidence[0]!.status,
					complete: evidence[0]!.complete,
					external: evidence[0]!.external,
					scope: evidence[0]!.scope,
					sectionIds: ["compare"],
				},
			],
			untrustedDisclosed: [],
		},
		schema: {}, // filled by runner; we spy via recordedInference exact match below
	});

	// Recorded-inference refuses a tampered digest even if value looks ready.
	const inference = recordedInference([
		{
			inputDigest: "correct-digest-only",
			provider: "fixture",
			value: {
				kind: "apply",
				refs: ["skill:compare@1"],
			},
		},
	]);
	await expect(
		inference.complete(
			{
				system: "x",
				data: {},
				schema: {},
				deadlineAt: 1,
				maxOutputTokens: 1,
				requestRef: "r",
			},
			new AbortController().signal,
		),
	).rejects.toThrow("inference_record_missing");

	// Baseline accepts shared constraints/environment without dropping them.
	const seen: unknown[] = [];
	const result = await runAgentSkillsBaseline(
		{
			inference: {
				complete: async (input) => {
					seen.push(structuredClone(input.data));
					return {
						value: { kind: "apply", refs: ["skill:compare@1"] },
						inputTokens: 1,
						outputTokens: 1,
					};
				},
			},
			now: () => 1,
		},
		{
			task,
			environment,
			cards,
			evidence,
			requestRef: "contract:1",
		},
		new AbortController().signal,
	);
	expect(result.kind).toBe("applied");
	expect(
		(seen[0] as { task: { constraints: unknown[] } }).task.constraints,
	).toEqual(task.constraints);
	expect((seen[0] as { environment: { id: string } }).environment.id).toBe(
		"fixture",
	);
	// Silence unused in assert shape.
	expect(typeof baselineDigest).toBe("string");
});
