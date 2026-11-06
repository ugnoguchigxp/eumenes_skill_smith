// Scenario eval (proposal 26/35): typed three-axis suite, two modes.
// Usage:
//   bun examples/contextstill/scenario-eval.ts                       # full: legacy 5-task suite, LLM judge replay
//   bun examples/contextstill/scenario-eval.ts --retrieval-only --suite examples/contextstill/scenarios/suite-3axis.json
//   options: --axis retrieval|compose|absent  --query-style original|exact|en|jp  --output-dir dir
//            --search-profile handle|bm25 (default handle)
//            --assembly-mode baseline|compact (default baseline; compact is opt-in, not adopted)
//            --build-records path --judge-records path --scores path --db path
// retrieval-only: SourcePort search only, zero inference, no 0-10 scores.
// full: product execute + recordedInference + recorded LLM judge. Missing records write pending tasks and exit 2.
// New reports go to --output-dir (default data/contextstill/scenario-reports); the repo scores.json is
// written only for the legacy suite in full mode without --output-dir when complete.
// Proposal 35: reports carry identity (profile/suite/seed/instruction digests), recordProvenance, measured usage.
import "../../scripts/test-preload.js";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ContextStillFixture } from "./database.js";
import { createMcpHandler } from "./mcp.js";
import { createFixtureSource } from "./source.js";
import { recordedInference, type InferenceRecord } from "./recorded.js";
import { parseAnyScenarioSuite } from "../../src/eval/scenario-score.js";
import {
	buildEvalIdentity,
	parseAssemblyMode,
	parseSearchProfile,
	runFull,
	runRetrievalOnly,
	summarizeRetrieval,
} from "./scenario-runner.js";

function raw(name: string) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}
function arg(name: string, fallback: string) {
	const value = raw(name);
	return value ? resolve(value) : resolve(fallback);
}
function loadRecords(path: string): InferenceRecord[] {
	if (!existsSync(path)) return [];
	const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
	return Array.isArray(data) ? (data as InferenceRecord[]) : [];
}

const searchProfile = parseSearchProfile(process.argv);
const assemblyMode = parseAssemblyMode(process.argv);
const retrievalOnly = process.argv.includes("--retrieval-only");
const suitePath = arg("--suite", "examples/contextstill/scenarios/suite.json");
const dbPath = arg("--db", "data/contextstill/seed.sqlite");
const outputDir = raw("--output-dir") ? resolve(raw("--output-dir")!) : null;
const reportDir = outputDir ?? resolve("data/contextstill/scenario-reports");
const axis = raw("--axis");
const queryStyle = raw("--query-style");
if (axis && !["retrieval", "compose", "absent"].includes(axis))
	throw new Error(`unknown --axis ${axis}`);
if (queryStyle && !["original", "exact", "en", "jp"].includes(queryStyle))
	throw new Error(`unknown --query-style ${queryStyle}`);

const suite = parseAnyScenarioSuite(
	JSON.parse(readFileSync(suitePath, "utf8")),
);
const tasks = suite.tasks.filter(
	(task) =>
		(!axis || task.axis === axis) &&
		(!queryStyle || task.queryStyle === queryStyle),
);
if (!tasks.length)
	throw new Error("no tasks after --axis/--query-style filter");
const fixture = new ContextStillFixture(dbPath, searchProfile);
const token = crypto.randomUUID();
const source = createFixtureSource(createMcpHandler(fixture, token), token);
const filter = { axis: axis ?? null, queryStyle: queryStyle ?? null };
const identity = buildEvalIdentity({
	searchProfile,
	assemblyMode,
	suiteId: suite.id,
	suitePath,
	seedPath: dbPath,
});

try {
	mkdirSync(reportDir, { recursive: true });
	if (retrievalOnly) {
		const rows = await runRetrievalOnly(tasks, source);
		const report = {
			ok: true,
			mode: "retrieval-only",
			suite: suite.id,
			searchProfile,
			assemblyMode,
			identity,
			filter,
			inferenceCalls: 0,
			summary: summarizeRetrieval(rows),
			rows,
			note: `Search ranks only (${searchProfile}-ordered fixture search, limit 20). No LLM scores. hit@20 is diagnostic. Absent axis recall is N/A. Not production ContextStill quality.`,
		};
		const path = resolve(reportDir, `retrieval-${suite.id}.json`);
		writeFileSync(path, JSON.stringify(report, null, 2));
		console.log(JSON.stringify({ ...report, reportFile: path }, null, 2));
	} else {
		const buildRecords = loadRecords(
			arg(
				"--build-records",
				"examples/contextstill/scenarios/build-records.json",
			),
		);
		const judgeRecords = loadRecords(
			arg(
				"--judge-records",
				"examples/contextstill/scenarios/judge-records.json",
			),
		);
		const result = await runFull({
			tasks,
			source,
			assemblyMode,
			createInference: (role, onTask) =>
				recordedInference(
					role === "build" ? buildRecords : judgeRecords,
					onTask,
				),
			hasBuildRecord: (d) => buildRecords.some((r) => r.inputDigest === d),
		});
		const pendingDir = resolve("data/contextstill");
		const pendingFiles: string[] = [];
		for (const [name, items] of [
			["scenario-build-pending.json", result.pendingBuild],
			["scenario-judge-pending.json", result.pendingJudge],
		] as const) {
			if (!items.length) continue;
			const path = resolve(pendingDir, name);
			writeFileSync(path, JSON.stringify(items, null, 2));
			pendingFiles.push(path);
		}
		const report = {
			ok: result.complete,
			mode: "full",
			suite: suite.id,
			searchProfile,
			assemblyMode,
			identity,
			filter,
			status: result.complete ? "complete" : "incomplete",
			tasks: tasks.length,
			scored: result.scores.length,
			meanScore: result.meanScore,
			statuses: result.statuses,
			scores: result.scores,
			recordProvenance: result.recordProvenance,
			usage: result.usage,
			pendingFiles,
			searchPreview: result.searchPreview,
			note: result.complete
				? "Scores are LLM judgments of skill assembly, not canned fixture verdicts."
				: "Incomplete: meanScore is withheld because not every task was scored.",
		};
		const legacyDefault =
			suite.format === "legacy" &&
			!outputDir &&
			!axis &&
			!queryStyle &&
			searchProfile === "handle" &&
			assemblyMode === "baseline";
		const scorePath = raw("--scores")
			? resolve(raw("--scores")!)
			: legacyDefault
				? resolve("examples/contextstill/scenarios/scores.json")
				: resolve(reportDir, `full-${suite.id}.json`);
		// Incomplete runs must not write score files as if complete (proposal 26/35).
		if (result.complete)
			writeFileSync(scorePath, JSON.stringify(report, null, 2));
		console.log(
			JSON.stringify(
				{ ...report, scoreFile: result.complete ? scorePath : null },
				null,
				2,
			),
		);
		if (!result.complete) process.exitCode = 2;
	}
} finally {
	fixture.close();
}
