import { expect, test } from "bun:test";
import { digest } from "../index.js";
import {
	COMPACT_INSTRUCTION_VERSION,
	INSTRUCTION_VERSION,
	buildInstructions,
	compactBuildInstructions,
} from "../instructions/build.js";
import {
	compactModelTurnSchema,
	compactReadySchema,
	decisionSchema,
	modelTurnSchema,
} from "../contracts/schema.js";
import {
	isNearEntireCopy,
	rejectDisclosedBodyRewrite,
	resolveAssembly,
	toStoredReady,
} from "../service/assembly.js";
import { checkDecision } from "../service/build.js";
import type { Evidence, Prepared, ReadyDecision } from "../contracts/types.js";

test("baseline buildInstructions and INSTRUCTION_VERSION stay unchanged by compact path", () => {
	expect(INSTRUCTION_VERSION).toBe("build." + digest(buildInstructions));
	expect(COMPACT_INSTRUCTION_VERSION).toBe(
		"build.compact." + digest(compactBuildInstructions),
	);
	expect(COMPACT_INSTRUCTION_VERSION).not.toBe(INSTRUCTION_VERSION);
	expect(compactBuildInstructions).not.toBe(buildInstructions);
	const baseline = resolveAssembly("baseline");
	expect(baseline.instructions).toBe(buildInstructions);
	expect(baseline.instructionVersion).toBe(INSTRUCTION_VERSION);
	expect(baseline.turnSchema).toBe(modelTurnSchema);
	const compact = resolveAssembly("compact");
	expect(compact.instructions).toBe(compactBuildInstructions);
	expect(compact.instructionVersion).toBe(COMPACT_INSTRUCTION_VERSION);
	expect(compact.turnSchema).toBe(compactModelTurnSchema);
});

test("baseline decisionSchema rejects coverage; compact accepts coverage and exploration", () => {
	const presentation = {
		name: "inspect-evidence",
		title: "根拠の確認",
		description: "根拠を確認する。調査の開始時に使う。",
		language: "ja",
		localizedInstructions: "根拠を確認し、結果を照合する。",
	};
	const reuse = {
		...presentation,
		kind: "ready" as const,
		strategy: "reuse" as const,
		sourceRefs: ["skill:a@1"],
		sections: [],
		patches: [],
		requiredCapabilities: [],
		verification: ["確認する"],
		assumptions: [],
	};
	expect(decisionSchema.safeParse(reuse).success).toBe(true);
	expect(
		decisionSchema.safeParse({ ...reuse, coverage: "sufficient" }).success,
	).toBe(false);
	expect(
		compactReadySchema.safeParse({ ...reuse, coverage: "sufficient" }).success,
	).toBe(true);
	const explore = {
		...presentation,
		kind: "ready" as const,
		strategy: "provisional" as const,
		sourceRefs: [],
		sections: [],
		patches: [],
		requiredCapabilities: [],
		verification: ["観測結果を記録する"],
		assumptions: [],
		coverage: "absent" as const,
		exploration: {
			targetAndVersion: "対象パッケージと版を確認する",
			officialSources: "公式ドキュメントの当たり方を書く",
			firstSafeObservation: "読み取り専用で状態を観測する",
			isolatedExperiment: "隔離環境で最小実験する",
			passStopConditions: "合格と中止の条件を書く",
			unresolvedAssumptions: "未解決前提を残す",
		},
	};
	expect(compactReadySchema.safeParse(explore).success).toBe(true);
	expect(
		compactModelTurnSchema.safeParse({
			kind: "disclose",
			items: [{ ref: "skill:a@1" }],
		}).success,
	).toBe(true);
	expect(
		compactReadySchema.safeParse({
			...explore,
			exploration: { targetAndVersion: "only" },
		}).success,
	).toBe(false);
});

test("reuse with non-empty sections still fails structural check", () => {
	const decision: ReadyDecision = {
		kind: "ready",
		strategy: "reuse",
		sourceRefs: ["skill:a@1"],
		sections: [{ id: "x", body: "書き直し本文は拒否されるべきである。" }],
		patches: [],
		requiredCapabilities: [],
		verification: ["確認する"],
		assumptions: [],
	};
	const evidence: Evidence[] = [
		{
			ref: "skill:a@1",
			version: { id: "a", version: "1", digest: "d", generation: 0 },
			title: "A",
			body: "本体",
			status: "active",
			complete: true,
			external: false,
			scope: "shared",
		},
	];
	const prepared = {
		record: {
			request: {
				environment: { capabilities: [] },
			},
			authority: { scope: "shared" },
		},
	} as unknown as Prepared;
	expect(() => checkDecision(decision, evidence, prepared)).toThrow(
		"invalid_reuse",
	);
});

test("compact adapt that pastes a disclosed body into sections is rejected", () => {
	const body =
		"これは開示済みSkillの本文であり、sectionsへの丸写しは拒否される。";
	const decision: ReadyDecision = {
		kind: "ready",
		strategy: "adapt",
		sourceRefs: ["skill:a@1"],
		sections: [{ id: "copy", body }],
		patches: [],
		requiredCapabilities: [],
		verification: ["確認する"],
		assumptions: [],
	};
	const evidence: Evidence[] = [
		{
			ref: "skill:a@1",
			version: { id: "a", version: "1", digest: "d", generation: 0 },
			title: "A",
			body,
			sections: [{ id: "s1", body: "短い追記用" }],
			status: "active",
			complete: true,
			external: false,
			scope: "shared",
		},
	];
	expect(isNearEntireCopy(body, body)).toBe(true);
	expect(() => rejectDisclosedBodyRewrite(decision, evidence)).toThrow(
		"invalid_rewrite",
	);
});

test("toStoredReady maps exploration slots into fixed section ids", () => {
	const stored = toStoredReady({
		name: "safe-exploration",
		title: "安全な探索",
		description: "対象を安全に調べる。根拠がないときに使う。",
		language: "ja",
		localizedInstructions: "対象を確認し、隔離して試し、観測結果を照合する。",
		kind: "ready",
		strategy: "provisional",
		sourceRefs: [],
		sections: [],
		patches: [],
		requiredCapabilities: [],
		verification: ["確認する"],
		assumptions: [],
		coverage: "absent",
		exploration: {
			targetAndVersion: "対象",
			officialSources: "公式",
			firstSafeObservation: "観測",
			isolatedExperiment: "実験",
			passStopConditions: "停止",
			unresolvedAssumptions: "前提",
		},
	});
	expect(stored.sections.map((s) => s.id)).toEqual([
		"target-version",
		"official-sources",
		"first-safe-observation",
		"isolated-experiment",
		"pass-stop-conditions",
		"unresolved-assumptions",
	]);
	expect("coverage" in stored).toBe(false);
	expect("exploration" in stored).toBe(false);
});
