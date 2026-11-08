import { seedFixturePath } from "./seed-fixture.js";
import { digest } from "../../../src/service/identity.js";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	parseAnyScenarioSuite,
	assemblyJudgeSchema,
} from "../../../src/eval/scenario-score.js";
import { disclosureInstructions } from "../../../src/instructions/build.js";
import { ContextStillFixture } from "../database.js";
import { createMcpHandler } from "../mcp.js";
import { createFixtureSource, type SourcePort } from "../source.js";
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
import {
	parseEvidenceSupply,
	oracleEvidenceSource,
	composeJudgeSchema,
} from "../compose-isolation.js";

const load = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const suitePath = "examples/contextstill/scenarios/suite-3axis.json";
const compose = parseAnyScenarioSuite(load(suitePath)).tasks.filter(
	(t) => t.axis === "compose",
);
const signal = () => new AbortController().signal;
function fixture(profile: "handle" | "bm25" = "handle") {
	const db = new ContextStillFixture(seedFixturePath(), profile);
	const token = crypto.randomUUID();
	return {
		db,
		source: createFixtureSource(createMcpHandler(db, token), token),
	};
}

test("evidence supply is strict and defaults to natural; current build digest tracked separately from archived instructions", () => {
	expect(parseEvidenceSupply([])).toBe("natural");
	expect(parseEvidenceSupply(["--evidence-supply", "natural"])).toBe("natural");
	expect(parseEvidenceSupply(["--evidence-supply", "oracle"])).toBe("oracle");
	for (const args of [["--evidence-supply"], ["--evidence-supply", "auto"]])
		expect(() => parseEvidenceSupply(args)).toThrow(
			"unknown --evidence-supply",
		);
	expect("build." + digest(disclosureInstructions)).toBe(
		"build.af6fa023174fee6ed36dd595a27bcbe013fca3ebdfeb3989629d7edf97b43623",
	);
	const args = {
		searchProfile: "handle" as const,
		suiteId: "seed-three-axis",
		suitePath: resolve(suitePath),
		seedPath: resolve(seedFixturePath()),
	};
	const natural = buildEvalIdentity(args);
	expect(natural.evidenceSupply).toBe("natural");
	expect(buildEvalIdentity({ ...args, evidenceSupply: "natural" })).toEqual(
		natural,
	);
	const oracle = buildEvalIdentity({ ...args, evidenceSupply: "oracle" });
	expect(oracle).not.toEqual(natural);
	expect(oracle.buildInstructionsDigest).toBe(natural.buildInstructionsDigest);
	expect(oracle.composeJudgeInstructionsDigest).toMatch(/^[a-f0-9]{64}$/);
	expect(oracle.composeJudgeSchemaDigest).toMatch(/^[a-f0-9]{64}$/);
});

test("natural compose retrieval rows remain byte-equivalent as parsed: handle 0/4, BM25 4/4", async () => {
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

test("oracle gets stored cards and bodies without search, delegates validation unchanged", async () => {
	const f = fixture();
	try {
		const refs = compose[0]!.expectedRefs;
		const docs = await Promise.all(
			refs.map((ref) => f.source.get(ref, signal())),
		);
		const source: SourcePort = {
			...f.source,
			search: async () => {
				throw new Error("rank must not matter");
			},
		};
		const oracle = await oracleEvidenceSource(source, refs, signal());
		const result = await oracle.search(
			"only the public searchTask",
			8,
			signal(),
		);
		expect(result.cards.map((c) => c.ref)).toEqual([...refs].sort());
		for (const doc of docs) {
			const card = result.cards.find((c) => c.ref === doc.ref)!;
			expect(card.title).toBe(doc.title);
			expect(card.version).toEqual(doc.version);
			expect(await oracle.get(doc.ref, signal())).toEqual(doc);
			expect(Object.keys(card).sort()).toEqual(
				[
					"ref",
					"version",
					"title",
					"status",
					"complete",
					"external",
					"scope",
				].sort(),
			);
		}
		expect(await oracle.validate(result.cards, signal())).toBe(true);
		expect((await oracle.search("ignored rank", 1, signal())).truncated).toBe(
			true,
		);
	} finally {
		f.db.close();
	}
});

test("oracle execute discloses real documents, never gold labels; missing next turn stays pending", async () => {
	const f = fixture();
	try {
		// Poison labels: stored titles remain normal; axis/labels must never enter builder data.
		const task = {
			...compose[0]!,
			expectedTitles: ["GOLD_TITLE_CANARY_A", "GOLD_TITLE_CANARY_B"],
		};
		const seen: InferenceTask[] = [];
		const gets: string[] = [];
		const source: SourcePort = {
			search: async () => {
				throw new Error("oracle must bypass search rank");
			},
			get: async (ref, s) => {
				gets.push(ref);
				return f.source.get(ref, s);
			},
			validate: (...a) => f.source.validate(...a),
		};
		const result = await runFull({
			assemblyMode: "legacy",
			tasks: [task],
			source,
			evidenceSupply: "oracle",
			hasBuildRecord: () => false,
			createInference: (role, onTask, context) => {
				expect(role).toBe("build");
				expect(context).toEqual({ evidenceSupply: "oracle" });
				const receipts = new Set<string>();
				let first = true;
				return {
					complete: async (input, s) => {
						const item = inferenceTask(input, context);
						seen.push(item);
						onTask(item);
						if (!first) throw new Error("inference_record_missing");
						first = false;
						s.throwIfAborted();
						const receipt = crypto.randomUUID();
						receipts.add(receipt);
						// Wiring-only disclosure, not an invented SKILL or quality score.
						return {
							value: {
								kind: "disclose",
								items: task.expectedRefs.map((ref) => ({ ref })),
							},
							receipt,
							inputTokens: null,
							outputTokens: null,
						};
					},
					validReceipt: (_tx, r) => receipts.has(r),
				};
			},
		});
		expect(seen).toHaveLength(2);
		for (const item of seen) {
			const dump = JSON.stringify(item.data);
			for (const forbidden of [
				"expectedTitle",
				"expectedRefs",
				'"axis"',
				"GOLD_TITLE_CANARY",
				"evidenceSupply",
			])
				expect(dump).not.toContain(forbidden);
		}
		const first = seen[0]!.data as {
			evidenceIndex: { ref: string; title: string }[];
		};
		expect(first.evidenceIndex.map((c) => c.ref).sort()).toEqual(
			[...task.expectedRefs].sort(),
		);
		for (const ref of task.expectedRefs) {
			expect(gets.filter((r) => r === ref).length).toBeGreaterThanOrEqual(2); // eval preload + core get
			const doc = await f.source.get(ref, signal());
			expect(JSON.stringify(seen[1]!.data)).toContain(
				JSON.stringify(doc.body).slice(1, -1),
			);
		}
		expect(result.statuses[0]!.status).toBe("awaiting_build_inference");
		expect(result.meanScore).toBeNull();
		expect(result.scores).toEqual([]);
		expect(result.composeScores).toEqual([]);
		expect(result.usage.buildInferenceTasks).toBe(2);
		expect(result.usage.evalEvidenceGetCalls).toBe(2);
		expect(result.usage.inputTokens).toBeNull();
		expect(result.usage.outputTokens).toBeNull();
	} finally {
		f.db.close();
	}
});

test("oracle replay namespace cannot consume natural records for identical model data", async () => {
	const input = {
		system: "wiring",
		data: { task: "public" },
		schema: {},
		requestRef: "test",
		maxOutputTokens: 10,
		deadlineAt: 1,
	};
	const natural = inferenceTask(input);
	const oracle = inferenceTask(input, { evidenceSupply: "oracle" });
	expect(oracle.inputDigest).not.toBe(natural.inputDigest);
	expect(oracle.data).toEqual(natural.data);
	const model = recordedInference(
		[{ inputDigest: natural.inputDigest, value: {}, provider: "wiring-only" }],
		() => {},
		{ evidenceSupply: "oracle" },
	);
	await expect(model.complete(input, signal())).rejects.toThrow(
		"inference_record_missing",
	);
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
				recordedInference(role === "build" ? build : judge, onTask, context, {
					namespace: "legacy",
				}),
			hasBuildRecord: (d) => build.some((r) => r.inputDigest === d),
		});
		expect(result.evidenceSupply).toBe("natural");
		expect(result.complete).toBe(true);
		expect(result.scores).toHaveLength(5);
		expect(result.meanScore).toBe(4.2);
		expect(result.composeScores).toEqual([]);
		expect(result.usage.evalEvidenceGetCalls).toBe(0);
		for (const record of judge)
			expect(assemblyJudgeSchema.safeParse(record.value).success).toBe(true);
		// The new dimensions are compose-only, not silently required on legacy records.
		expect(composeJudgeSchema.safeParse(judge[0]!.value).success).toBe(false);
	} finally {
		f.db.close();
	}
});

test("compose judge receives reference bodies and dimensions only after build; missing judge remains pending", async () => {
	const f = fixture("bm25");
	try {
		const task = compose[0]!;
		const result = await runFull({
			assemblyMode: "legacy",
			tasks: [task],
			source: f.source,
			hasBuildRecord: () => true,
			createInference: (role, onTask, context) => {
				if (role === "judge") return recordedInference([], onTask, context);
				// Terminal wiring fixture only: no SKILL text or score is invented.
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
		expect(result.composeScores).toEqual([]);
		expect(result.usage.judgeInferenceTasks).toBe(1);
		expect(result.usage.evalEvidenceGetCalls).toBe(task.expectedRefs.length);
		const pending = result.pendingJudge[0]!.tasks[0]!;
		const data = pending.data as {
			evidenceSupply: string;
			referenceEvidence: { ref: string; title: string; body: string }[];
		};
		expect(data.evidenceSupply).toBe("natural");
		for (const ref of task.expectedRefs) {
			const doc = await f.source.get(ref, signal());
			expect(data.referenceEvidence.find((e) => e.ref === ref)).toEqual({
				ref,
				title: doc.title,
				body: doc.body,
			});
		}
		expect((pending.schema as { required: string[] }).required).toEqual([
			"score",
			"expectedSkillUsed",
			"rationale",
			"coverage",
			"coherence",
			"conflictHandling",
			"actionability",
		]);
	} finally {
		f.db.close();
	}
});
