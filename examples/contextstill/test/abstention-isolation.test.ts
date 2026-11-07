import {
	CURRENT_ABSTENTION_JUDGE_INSTRUCTIONS,
	currentAbstentionJudgeOutputSchema,
} from "../abstention-isolation.js";
import { JUDGE_DATA_BOUNDARY } from "../../../src/eval/scenario-score.js";
import { semanticReviewInstructions } from "../../../src/instructions/build.js";
import { digest } from "../../../src/service/identity.js";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	parseAnyScenarioSuite,
	assemblyJudgeSchema,
} from "../../../src/eval/scenario-score.js";
import {
	disclosureInstructions,
	buildInstructions,
} from "../../../src/instructions/build.js";
import { ContextStillFixture } from "../database.js";
import { createMcpHandler } from "../mcp.js";
import { createFixtureSource } from "../source.js";
import {
	buildEvalIdentity,
	runFull,
	runRetrievalOnly,
} from "../scenario-runner.js";
import {
	recordedInference,
	type InferenceRecord,
	type InferenceTask,
} from "../recorded.js";
import {
	abstentionJudgeDigests,
	abstentionJudgeSchema,
	expectedRefsRetrieved,
	parseAbstentionContrast,
} from "../abstention-isolation.js";

const load = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const scen = "examples/contextstill/scenarios";
const suitePath = `${scen}/suite-3axis.json`;
const compose = parseAnyScenarioSuite(load(suitePath)).tasks.filter(
	(t) => t.axis === "compose",
);
const legacy = parseAnyScenarioSuite(load(`${scen}/suite.json`)).tasks;
function fixture(profile: "handle" | "bm25" = "handle") {
	const db = new ContextStillFixture("data/contextstill/seed.sqlite", profile);
	const token = crypto.randomUUID();
	return {
		db,
		source: createFixtureSource(createMcpHandler(db, token), token),
	};
}

test("contrast judge digests are stable; current build digest tracked separately from archived instructions; flag strict", () => {
	expect("build." + digest(disclosureInstructions)).toBe(
		"build.af6fa023174fee6ed36dd595a27bcbe013fca3ebdfeb3989629d7edf97b43623",
	);
	const digests = abstentionJudgeDigests();
	expect(digests).toEqual(abstentionJudgeDigests());
	expect(digests.abstentionJudgeInstructionsDigest).toMatch(/^[a-f0-9]{64}$/);
	expect(digests.abstentionJudgeSchemaDigest).toMatch(/^[a-f0-9]{64}$/);
	const base = {
		searchProfile: "handle" as const,
		suiteId: "seed-three-axis",
		suitePath: resolve(suitePath),
		seedPath: resolve("data/contextstill/seed.sqlite"),
	};
	const off = buildEvalIdentity(base);
	const on = buildEvalIdentity({ ...base, abstentionContrast: "on" });
	expect(off.abstentionContrast).toBe("off");
	expect(on.abstentionContrast).toBe("on");
	expect(on.abstentionJudgeInstructionsDigest).toBe(
		digest(CURRENT_ABSTENTION_JUDGE_INSTRUCTIONS + "\n" + JUDGE_DATA_BOUNDARY),
	);
	expect(on.abstentionJudgeSchemaDigest).toBe(
		digest(currentAbstentionJudgeOutputSchema),
	);
	expect(on.abstentionJudgeSchemaDigest).not.toBe(
		digests.abstentionJudgeSchemaDigest,
	);
	const archived = buildEvalIdentity({ ...base, assemblyMode: "legacy" });
	expect(archived.abstentionJudgeSchemaDigest).toBe(
		digests.abstentionJudgeSchemaDigest,
	);
	expect(off.buildInstructionsDigest).toBe(
		digest(buildInstructions + semanticReviewInstructions),
	);
	expect(parseAbstentionContrast([])).toBe("off");
	expect(parseAbstentionContrast(["--abstention-contrast", "on"])).toBe("on");
	expect(() => parseAbstentionContrast(["--abstention-contrast"])).toThrow();
	expect(() =>
		parseAbstentionContrast(["--abstention-contrast", "yes"]),
	).toThrow();
});

test("original-five handle full replay remains 5 scored / mean 4.2 with flag omitted", async () => {
	const f = fixture();
	const build = load(`${scen}/build-records.json`) as InferenceRecord[];
	const judge = load(`${scen}/judge-records.json`) as InferenceRecord[];
	try {
		const result = await runFull({
			assemblyMode: "legacy",
			tasks: legacy,
			source: f.source,
			createInference: (role, onTask, context) =>
				recordedInference(role === "build" ? build : judge, onTask, context, {
					namespace: "legacy",
				}),
			hasBuildRecord: (d) => build.some((r) => r.inputDigest === d),
		});
		expect(result.complete).toBe(true);
		expect(result.scores).toHaveLength(5);
		expect(result.meanScore).toBe(4.2);
		expect(result.abstentionScores).toEqual([]);
		for (const record of judge) {
			expect(assemblyJudgeSchema.safeParse(record.value).success).toBe(true);
			expect(abstentionJudgeSchema.safeParse(record.value).success).toBe(false);
		}
	} finally {
		f.db.close();
	}
});

test("flag on reuses build records but never original-five judge records; stays pending", async () => {
	const f = fixture();
	const build = load(`${scen}/build-records.json`) as InferenceRecord[];
	const judge = load(`${scen}/judge-records.json`) as InferenceRecord[];
	try {
		const result = await runFull({
			assemblyMode: "legacy",
			tasks: legacy,
			source: f.source,
			abstentionContrast: "on",
			createInference: (role, onTask, context) =>
				recordedInference(role === "build" ? build : judge, onTask, context, {
					namespace: "legacy",
				}),
			hasBuildRecord: (d) => build.some((r) => r.inputDigest === d),
		});
		expect(result.complete).toBe(false);
		expect(result.statuses.map((s) => s.status)).toEqual(
			Array(5).fill("awaiting_judge"),
		);
		expect(result.scores).toEqual([]);
		expect(result.meanScore).toBeNull();
		expect(result.abstentionScores).toEqual([]);
		expect(result.usage.inputTokens).toBeNull();
		expect(result.usage.outputTokens).toBeNull();
		const old = new Set(judge.map((r) => r.inputDigest));
		for (const p of result.pendingJudge) {
			const t = p.tasks[0]!;
			expect(old.has(t.inputDigest)).toBe(false);
			expect(t.system).toContain("適切な棄権");
			const data = t.data as {
				expectedRefsRetrieved: string[];
				retrieved: { ref: string }[];
				task: { expectedRefs: string[] };
			};
			expect(data.expectedRefsRetrieved).toEqual(
				expectedRefsRetrieved(data.task.expectedRefs, data.retrieved),
			);
			expect((t.schema as { required: string[] }).required).toEqual([
				"score",
				"expectedSkillUsed",
				"rationale",
				"treatsExistingAsAbsent",
				"excessiveAbstention",
				"appropriateGap",
			]);
		}
	} finally {
		f.db.close();
	}
});

test("compose natural handle records also stay pending under contrast (no compose judge reuse)", async () => {
	const f = fixture();
	const build = load(
		`${scen}/build-records-compose-natural-handle.json`,
	) as InferenceRecord[];
	const judge = load(
		`${scen}/judge-records-compose-natural-handle.json`,
	) as InferenceRecord[];
	try {
		const result = await runFull({
			assemblyMode: "legacy",
			tasks: compose,
			source: f.source,
			abstentionContrast: "on",
			createInference: (role, onTask, context) =>
				recordedInference(role === "build" ? build : judge, onTask, context, {
					namespace: "legacy",
				}),
			hasBuildRecord: (d) => build.some((r) => r.inputDigest === d),
		});
		expect(result.pendingBuild).toEqual([]);
		expect(result.statuses.every((s) => s.status === "awaiting_judge")).toBe(
			true,
		);
		expect(result.composeScores).toEqual([]);
		expect(result.abstentionScores).toEqual([]);
		expect(result.meanScore).toBeNull();
	} finally {
		f.db.close();
	}
});

test("natural compose retrieval canaries remain: handle 0/4, BM25 4/4", async () => {
	for (const profile of ["handle", "bm25"] as const) {
		const f = fixture(profile);
		try {
			const rows = await runRetrievalOnly(compose, f.source);
			expect(rows.filter((r) => r.allRequiredHitAt8).length).toBe(
				profile === "handle" ? 0 : 4,
			);
		} finally {
			f.db.close();
		}
	}
});

test("builder never sees gold, axis, false-friend, or contrast canaries", async () => {
	const f = fixture();
	try {
		const task = {
			...compose[0]!,
			expectedTitles: ["GOLD_CONTRAST_TITLE_CANARY"],
			nearestFalseFriendRefs: ["contextstill:FALSE_FRIEND_CANARY_REF"],
		};
		const seen: InferenceTask[] = [];
		const result = await runFull({
			assemblyMode: "legacy",
			tasks: [task],
			source: f.source,
			abstentionContrast: "on",
			hasBuildRecord: () => false,
			createInference: (role, onTask, context) => {
				expect(role).toBe("build");
				expect(context).toBeUndefined();
				return recordedInference([], (item) => {
					seen.push(item);
					onTask(item);
				});
			},
		});
		expect(seen.length).toBeGreaterThan(0);
		for (const item of seen) {
			const dump = JSON.stringify(item.data);
			for (const forbidden of [
				"expectedTitle",
				"expectedRefs",
				'"axis"',
				"nearestFalseFriend",
				"evidenceSupply",
				"GOLD_CONTRAST_TITLE_CANARY",
				"FALSE_FRIEND_CANARY_REF",
				"appropriateGap",
				"excessiveAbstention",
				"treatsExistingAsAbsent",
			])
				expect(dump).not.toContain(forbidden);
			expect(Object.keys((item.data as { task: object }).task).sort()).toEqual([
				"acceptance",
				"constraints",
				"goal",
				"references",
			]);
		}
		expect(result.statuses[0]!.status).toBe("awaiting_build_inference");
		expect(result.abstentionScores).toEqual([]);
		expect(result.usage.inputTokens).toBeNull();
		expect(result.usage.outputTokens).toBeNull();
	} finally {
		f.db.close();
	}
});
