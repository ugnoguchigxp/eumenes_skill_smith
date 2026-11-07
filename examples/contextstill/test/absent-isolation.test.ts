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
	inferenceTask,
	recordedInference,
	type InferenceRecord,
	type InferenceTask,
} from "../recorded.js";
import { composeJudgeSchema } from "../compose-isolation.js";
import { absentJudgeSchema, absentJudgeDigests } from "../absent-isolation.js";

const load = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const suitePath = "examples/contextstill/scenarios/suite-3axis.json";
const absent = parseAnyScenarioSuite(load(suitePath)).tasks.filter(
	(t) => t.axis === "absent",
);
const compose = parseAnyScenarioSuite(load(suitePath)).tasks.filter(
	(t) => t.axis === "compose",
);
function fixture(profile: "handle" | "bm25" = "handle") {
	const db = new ContextStillFixture("data/contextstill/seed.sqlite", profile);
	const token = crypto.randomUUID();
	return {
		db,
		source: createFixtureSource(createMcpHandler(db, token), token),
	};
}

test("absent judge digests are stable; current build digest tracked separately from archived instructions", () => {
	expect("build." + digest(disclosureInstructions)).toBe(
		"build.af6fa023174fee6ed36dd595a27bcbe013fca3ebdfeb3989629d7edf97b43623",
	);
	const digests = absentJudgeDigests();
	expect(digests.absentJudgeInstructionsDigest).toMatch(/^[a-f0-9]{64}$/);
	expect(digests.absentJudgeSchemaDigest).toMatch(/^[a-f0-9]{64}$/);
	const args = {
		searchProfile: "handle" as const,
		suiteId: "seed-three-axis",
		suitePath: resolve(suitePath),
		seedPath: resolve("data/contextstill/seed.sqlite"),
	};
	const identity = buildEvalIdentity(args);
	expect(identity.absentJudgeInstructionsDigest).toBe(
		digests.absentJudgeInstructionsDigest,
	);
	expect(identity.absentJudgeSchemaDigest).toBe(
		digests.absentJudgeSchemaDigest,
	);
	expect(identity.buildInstructionsDigest).toBe(
		digest(buildInstructions + semanticReviewInstructions),
	);
	expect(identity.composeJudgeInstructionsDigest).toMatch(/^[a-f0-9]{64}$/);
});

test("natural compose retrieval canaries remain: handle 0/4, BM25 4/4", async () => {
	for (const profile of ["handle", "bm25"] as const) {
		const f = fixture(profile);
		try {
			const rows = await runRetrievalOnly(compose, f.source);
			expect(rows).toEqual(
				load(
					`examples/contextstill/scenarios/retrieval-compose-${profile}.json`,
				).rows,
			);
			expect(rows.filter((r) => r.allRequiredHitAt8).length).toBe(
				profile === "handle" ? 0 : 4,
			);
		} finally {
			f.db.close();
		}
	}
});

test("absent retrieval-only stays N/A recall and never invents scores", async () => {
	const f = fixture();
	try {
		const rows = await runRetrievalOnly(absent, f.source);
		expect(rows).toHaveLength(4);
		for (const row of rows) {
			expect(row.axis).toBe("absent");
			expect(row.allRequiredHitAt8).toBeNull();
			expect(row.allRequiredHitAt20Diagnostic).toBeNull();
			expect(row.ranks).toEqual([]);
		}
	} finally {
		f.db.close();
	}
});

test("absent builder never sees axis, gold labels, or false-friend canaries; missing stays pending", async () => {
	const f = fixture();
	try {
		const task = {
			...absent[0]!,
			expectedTitles: ["GOLD_ABSENT_TITLE_CANARY"],
			nearestFalseFriendRefs: [
				...absent[0]!.nearestFalseFriendRefs,
				"contextstill:FALSE_FRIEND_CANARY_REF",
			],
		};
		const seen: InferenceTask[] = [];
		const result = await runFull({
			assemblyMode: "legacy",
			tasks: [task],
			source: f.source,
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
				"GOLD_ABSENT_TITLE_CANARY",
				"FALSE_FRIEND_CANARY_REF",
				"absentJudge",
			])
				expect(dump).not.toContain(forbidden);
			const data = item.data as {
				task: Record<string, unknown>;
				evidenceIndex: unknown;
			};
			expect(Object.keys(data.task).sort()).toEqual(
				["acceptance", "constraints", "goal", "references"].sort(),
			);
			expect(data.task.references).toEqual([]);
			expect(data.task.goal).toBe(task.goal);
		}
		expect(result.statuses[0]!.status).toBe("awaiting_build_inference");
		expect(result.meanScore).toBeNull();
		expect(result.scores).toEqual([]);
		expect(result.composeScores).toEqual([]);
		expect(result.absentScores).toEqual([]);
		expect(result.usage.inputTokens).toBeNull();
		expect(result.usage.outputTokens).toBeNull();
	} finally {
		f.db.close();
	}
});

test("original-five handle full replay remains 5 scored / mean 4.2", async () => {
	const f = fixture();
	const tasks = parseAnyScenarioSuite(
		load("examples/contextstill/scenarios/suite.json"),
	).tasks;
	const build = load(
		"examples/contextstill/scenarios/build-records.json",
	) as InferenceRecord[];
	const judge = load(
		"examples/contextstill/scenarios/judge-records.json",
	) as InferenceRecord[];
	try {
		const result = await runFull({
			assemblyMode: "legacy",
			tasks,
			source: f.source,
			createInference: (role, onTask, context) =>
				recordedInference(role === "build" ? build : judge, onTask, context),
			hasBuildRecord: (d) => build.some((r) => r.inputDigest === d),
		});
		expect(result.complete).toBe(true);
		expect(result.scores).toHaveLength(5);
		expect(result.meanScore).toBe(4.2);
		expect(result.composeScores).toEqual([]);
		expect(result.absentScores).toEqual([]);
		for (const record of judge)
			expect(assemblyJudgeSchema.safeParse(record.value).success).toBe(true);
		expect(absentJudgeSchema.safeParse(judge[0]!.value).success).toBe(false);
		expect(composeJudgeSchema.safeParse(judge[0]!.value).success).toBe(false);
	} finally {
		f.db.close();
	}
});

test("absent judge receives watch-list only after build; missing judge remains pending", async () => {
	const f = fixture();
	try {
		const task = absent[0]!;
		const result = await runFull({
			assemblyMode: "legacy",
			tasks: [task],
			source: f.source,
			hasBuildRecord: () => true,
			createInference: (role, onTask, context) => {
				if (role === "judge") return recordedInference([], onTask, context);
				const receipts = new Set<string>();
				return {
					complete: async (input) => {
						onTask(inferenceTask(input, context));
						const receipt = crypto.randomUUID();
						receipts.add(receipt);
						return {
							value: { kind: "unavailable", code: "wiring_only" },
							receipt,
							inputTokens: null,
							outputTokens: null,
						};
					},
					validReceipt: (_tx, r) => receipts.has(r),
				};
			},
		});
		expect(result.statuses[0]!.status).toBe("awaiting_judge");
		expect(result.meanScore).toBeNull();
		expect(result.scores).toEqual([]);
		expect(result.absentScores).toEqual([]);
		expect(result.usage.judgeInferenceTasks).toBe(1);
		const pending = result.pendingJudge[0]!.tasks[0]!;
		expect(pending.system).toContain("専用の一致 Skill");
		const data = pending.data as {
			nearestFalseFriendRefs: string[];
			task: { axis: string; expectedRefs: string[] };
		};
		expect(data.task.axis).toBe("absent");
		expect(data.task.expectedRefs).toEqual([]);
		expect(data.nearestFalseFriendRefs).toEqual(task.nearestFalseFriendRefs);
		expect((pending.schema as { required: string[] }).required).toEqual([
			"score",
			"expectedSkillUsed",
			"rationale",
			"boundedExploration",
			"inventsOfficialSkill",
			"claimsVerified",
			"actionability",
		]);
		// Builder turns must still omit the watch-list and axis gold.
		for (const item of result.pendingJudge) {
			void item;
		}
	} finally {
		f.db.close();
	}
});
