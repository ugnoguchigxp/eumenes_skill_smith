import { digest } from "../../../src/service/identity.js";
// Proposal 34: per-axis judges are reported per axis; a mixed run never blends them.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseAnyScenarioSuite } from "../../../src/eval/scenario-score.js";
import { disclosureInstructions } from "../../../src/instructions/build.js";
import { ContextStillFixture } from "../database.js";
import { createMcpHandler } from "../mcp.js";
import { createFixtureSource } from "../source.js";
import { axisSpecificMeans, runFull } from "../scenario-runner.js";
import { recordedInference, type InferenceRecord } from "../recorded.js";

const dir = "examples/contextstill/scenarios";
const load = (name: string) =>
	JSON.parse(readFileSync(`${dir}/${name}`, "utf8"));
const records = (name: string) => load(name) as InferenceRecord[];
const three = parseAnyScenarioSuite(load("suite-3axis.json")).tasks;
const originalFive = parseAnyScenarioSuite(load("suite.json")).tasks;

async function replay(
	profile: "handle" | "bm25",
	tasks: typeof three,
	build: InferenceRecord[],
	judge: InferenceRecord[],
) {
	const db = new ContextStillFixture("data/contextstill/seed.sqlite", profile);
	const token = crypto.randomUUID();
	try {
		return await runFull({
			assemblyMode: "legacy",
			tasks,
			source: createFixtureSource(createMcpHandler(db, token), token),
			createInference: (role, onTask, context) =>
				recordedInference(role === "build" ? build : judge, onTask, context),
			hasBuildRecord: (d) => build.some((r) => r.inputDigest === d),
		});
	} finally {
		db.close();
	}
}

test("archived instruction version remains stable", () => {
	expect("build." + digest(disclosureInstructions)).toBe(
		"build.af6fa023174fee6ed36dd595a27bcbe013fca3ebdfeb3989629d7edf97b43623",
	);
});

test("original-five only keeps meanScore 4.2 and retrieval axis mean 4.2", async () => {
	const r = await replay(
		"handle",
		originalFive,
		records("build-records.json"),
		records("judge-records.json"),
	);
	expect(r.complete).toBe(true);
	expect(r.scores).toHaveLength(5);
	expect(r.mixedAxes).toBe(false);
	expect(r.meanScore).toBe(4.2);
	expect(r.axisMeans).toEqual({ retrieval: 4.2, compose: null, absent: null });
	expect(r.usage.inputTokens).toBeNull();
	expect(r.usage.outputTokens).toBeNull();
});

test("absent-only keeps its single-axis meanScore", async () => {
	const r = await replay(
		"handle",
		three.filter((t) => t.axis === "absent"),
		records("build-records-absent-baseline.json"),
		records("judge-records-absent-baseline.json"),
	);
	expect(r.complete).toBe(true);
	expect(r.mixedAxes).toBe(false);
	expect(r.meanScore).toBe(8);
	expect(r.axisMeans).toEqual({ retrieval: null, compose: null, absent: 8 });
});

test("compose-only (BM25 natural) keeps its single-axis meanScore", async () => {
	const r = await replay(
		"bm25",
		three.filter((t) => t.axis === "compose"),
		records("build-records-compose-natural-bm25.json"),
		records("judge-records-compose-natural-bm25.json"),
	);
	expect(r.complete).toBe(true);
	expect(r.mixedAxes).toBe(false);
	expect(r.meanScore).toBe(r.axisMeans.compose);
	expect(r.axisMeans.compose).not.toBeNull();
	expect(r.axisMeans.retrieval).toBeNull();
});

test("mixed retrieval + absent run withholds the blended mean", async () => {
	const r = await replay(
		"handle",
		[...originalFive, ...three.filter((t) => t.axis === "absent")],
		[
			...records("build-records.json"),
			...records("build-records-absent-baseline.json"),
		],
		[
			...records("judge-records.json"),
			...records("judge-records-absent-baseline.json"),
		],
	);
	expect(r.complete).toBe(true);
	expect(r.scores).toHaveLength(9);
	expect(r.mixedAxes).toBe(true);
	expect(r.meanScore).toBeNull();
	// Not (21 + 32) / 9: retrieval 1s stay retrieval, absent 8s stay absent.
	expect(r.axisMeans).toEqual({ retrieval: 4.2, compose: null, absent: 8 });
	expect(r.usage.inputTokens).toBeNull();
});

test("axis mean is withheld unless every task of that axis scored", () => {
	const statuses = [
		{ taskId: "a", axis: "retrieval", status: "scored" as const },
		{ taskId: "b", axis: "compose", status: "scored" as const },
		{ taskId: "c", axis: "compose", status: "awaiting_judge" as const },
	];
	const scores = [
		{ taskId: "a", score: 1 },
		{ taskId: "b", score: 8 },
	];
	expect(axisSpecificMeans(statuses, scores, false)).toEqual({
		meanScore: null,
		axisMeans: { retrieval: 1, compose: null, absent: null },
		mixedAxes: true,
	});
	expect(axisSpecificMeans(statuses.slice(0, 2), scores, true)).toEqual({
		meanScore: null,
		axisMeans: { retrieval: 1, compose: 8, absent: null },
		mixedAxes: true,
	});
});
