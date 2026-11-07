import { builderPackets, parseDocumentLimit } from "./builder-packets.js";
import { writeSkillArtifact } from "./skill-output.js";
// Scenario eval (proposal 26/35/32): typed three-axis suite, two modes; absent uses a dedicated judge.
// Usage:
//   bun examples/contextstill/scenario-eval.ts                       # full: legacy 5-task suite, LLM judge replay
//   bun examples/contextstill/scenario-eval.ts --retrieval-only --suite examples/contextstill/scenarios/suite-3axis.json
//   options: --axis retrieval|compose|absent  --query-style original|exact|en|jp  --output-dir dir
//            --search-profile handle|bm25 (default bm25; exact-title pin applies to both)
//            --evidence-supply natural|oracle (default natural; oracle is full eval only)
//            --assembly-mode baseline|compact (default baseline; compact is opt-in, not adopted)
//            --query-reformulation off|on|auto|multi (default auto: Japanese or non-title
//              searchTasks; identity records on if any search fired, else off; multi stays opt-in)
//            --reformulation-records path (on default: examples/contextstill/scenarios/reformulation-records.json)
//            multi default: data/contextstill/multi-query-records.json (missing means pending)
//            --abstention-contrast off|on (default off; proposal 33 opt-in, requires --full)
//            --build-records path --judge-records path --scores path --db path
// --builder-only: stdout/files contain only provider pending packets; never host scores or judge tasks.
// retrieval-only: SourcePort search only; optional auxiliary inference, no build/judge or 0-10 scores.
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
import {
	recordedInference,
	type InferenceRecord,
	type InferenceTask,
} from "./recorded.js";
import {
	createAutoReformulatingSource,
	createReformulatingSource,
	parseQueryReformulation,
	type ReformulationTrace,
} from "./query-reformulation.js";
import { createMultiQuerySource, type MultiQueryTrace } from "./multi-query.js";
import { parseEvidenceSupply } from "./compose-isolation.js";
import { parseAbstentionContrast } from "./abstention-isolation.js";
import { parseAnyScenarioSuite } from "../../src/eval/scenario-score.js";
import {
	buildEvalIdentity,
	parseAssemblyMode,
	parseSearchProfile,
	runFull,
	runRetrievalOnly,
	summarizeRetrieval,
	type PendingReformulation,
	type ReformulationLedger,
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

const documentLimit = parseDocumentLimit(process.argv);
const searchProfile = parseSearchProfile(process.argv);
const assemblyMode = parseAssemblyMode(process.argv);
const evidenceSupply = parseEvidenceSupply(process.argv);
const queryReformulation = parseQueryReformulation(process.argv);
const retrievalOnly = process.argv.includes("--retrieval-only");
const builderOnly = process.argv.includes("--builder-only");
const abstentionContrast = parseAbstentionContrast(process.argv);
if (
	builderOnly &&
	(retrievalOnly ||
		evidenceSupply !== "natural" ||
		abstentionContrast !== "off")
)
	throw new Error(
		"builder-only requires full natural evaluation without abstention contrast",
	);
if (
	abstentionContrast === "on" &&
	(retrievalOnly || !process.argv.includes("--full"))
)
	throw new Error("--abstention-contrast on requires --full");
if (retrievalOnly && evidenceSupply !== "natural")
	throw new Error("--evidence-supply oracle requires full evaluation");
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
const fixtureSource = createFixtureSource(
	createMcpHandler(fixture, token),
	token,
);
// Proposal 28: off leaves the fixture source untouched (default path unchanged).
const reformulationTraces: (ReformulationTrace | MultiQueryTrace)[] = [];
let reformulationCalls = 0;
const replayNamespace =
	raw("--replay-namespace") ??
	(assemblyMode === "legacy" ? "legacy" : "execution.v2");
if (replayNamespace !== "legacy" && replayNamespace !== "execution.v2")
	throw new Error("replay_namespace_invalid");
let reformulationLedger: ReformulationLedger | undefined;
let source = fixtureSource;
let autoFired = false;
if (queryReformulation !== "off") {
	const records = loadRecords(
		arg(
			"--reformulation-records",
			queryReformulation === "multi"
				? "data/contextstill/multi-query-records.json"
				: queryReformulation === "auto"
					? "examples/contextstill/scenarios/reformulation-records-default.json"
					: "examples/contextstill/scenarios/reformulation-records.json",
		),
	);
	const collected: InferenceTask[] = [];
	reformulationLedger = {
		drain: () => collected.splice(0),
		hasRecord: (d) => records.some((r) => r.inputDigest === d),
	};
	const wrap =
		queryReformulation === "multi"
			? createMultiQuerySource
			: createReformulatingSource;
	const wrapped = wrap(
		fixtureSource,
		recordedInference(
			records,
			(item) => {
				reformulationCalls += 1;
				collected.push(item);
			},
			undefined,
			{ namespace: replayNamespace },
		),
		{
			deadlineAt: 1_700_000_000_000 + 120_000,
			onTrace: (trace) => reformulationTraces.push(trace),
		},
	);
	source =
		queryReformulation === "auto"
			? createAutoReformulatingSource(fixtureSource, wrapped, () => {
					autoFired = true;
				})
			: wrapped;
}
const pendingReformulation: PendingReformulation[] = [];
function writePendingReformulation(items: PendingReformulation[]) {
	if (!items.length) return null;
	const path = resolve("data/contextstill/scenario-reformulation-pending.json");
	writeFileSync(path, JSON.stringify(items, null, 2));
	return path;
}
const filter = { axis: axis ?? null, queryStyle: queryStyle ?? null };
// auto resolves to the condition that actually shaped searches: on if any searchTask fired.
const effectiveReformulation = () =>
	queryReformulation === "auto"
		? autoFired
			? "on"
			: "off"
		: queryReformulation;
const identityFor = () =>
	buildEvalIdentity({
		searchProfile,
		documentLimit,
		assemblyMode,
		suiteId: suite.id,
		suitePath,
		seedPath: dbPath,
		queryReformulation: effectiveReformulation(),
		evidenceSupply,
		abstentionContrast,
	});

try {
	mkdirSync(reportDir, { recursive: true });
	if (retrievalOnly) {
		const rows = await runRetrievalOnly(
			tasks,
			source,
			reformulationLedger,
			pendingReformulation,
		);
		const pendingFile = writePendingReformulation(pendingReformulation);
		const report = {
			ok: !pendingFile,
			...(pendingFile
				? { status: "awaiting_reformulation_inference", pendingFile }
				: {}),
			mode: "retrieval-only",
			suite: suite.id,
			searchProfile,
			documentLimit,
			assemblyMode,
			queryReformulationMode: queryReformulation,
			replayNamespace,
			identity: identityFor(),
			filter,
			// Search-only: zero build/judge inference; reformulation calls are counted separately.
			inferenceCalls: 0,
			...(effectiveReformulation() !== "off"
				? {
						reformulationInferenceTasks: reformulationCalls,
						inputTokens: null,
						outputTokens: null,
						reformulationTraces,
					}
				: {}),
			summary: summarizeRetrieval(rows),
			rows,
			note: `Search ranks only (${searchProfile}-ordered fixture search, limit 20). No LLM scores. hit@20 is diagnostic. Absent axis recall is N/A. Not production ContextStill quality.`,
		};
		const path = resolve(reportDir, `retrieval-${suite.id}.json`);
		// Pending runs must not write a ranks report as if complete.
		if (!pendingFile) writeFileSync(path, JSON.stringify(report, null, 2));
		console.log(
			JSON.stringify(
				{ ...report, reportFile: pendingFile ? null : path },
				null,
				2,
			),
		);
		if (pendingFile) process.exitCode = 2;
	} else {
		const buildRecords = loadRecords(
			arg(
				"--build-records",
				"examples/contextstill/scenarios/build-records.json",
			),
		);
		const judgeRecords = builderOnly
			? []
			: loadRecords(
					arg(
						"--judge-records",
						"examples/contextstill/scenarios/judge-records.json",
					),
				);
		const skillFiles: {
			taskId: string;
			path: string;
			digest: string;
			rendererVersion: string;
			sourceExtractorVersion: string;
		}[] = [];
		const result = await runFull({
			onSkill: (taskId, skill) => {
				const path = writeSkillArtifact(
					resolve(reportDir, "skills", `task-${encodeURIComponent(taskId)}`),
					skill,
				);
				skillFiles.push({
					taskId,
					path,
					digest: skill.digest,
					rendererVersion: skill.rendererVersion,
					sourceExtractorVersion: skill.sourceExtractorVersion,
				});
			},
			tasks,
			source,
			documentLimit,
			assemblyMode,
			evidenceSupply,
			abstentionContrast,
			createInference: (role, onTask, recordContext) =>
				recordedInference(
					role === "build" ? buildRecords : judgeRecords,
					onTask,
					recordContext,
					{ namespace: replayNamespace },
				),
			hasBuildRecord: (d) => buildRecords.some((r) => r.inputDigest === d),
			reformulation: reformulationLedger,
		});
		if (builderOnly) {
			const packets = builderPackets(
				result.pendingBuild,
				result.pendingReformulation,
			);
			const json = JSON.stringify(packets, null, 2);
			writeFileSync(resolve(reportDir, "builder-packets.json"), json);
			console.log(json);
			process.exitCode = packets.length ? 2 : 0;
		} else {
			const pendingDir = outputDir ?? resolve("data/contextstill");
			const pendingFiles: string[] = [];
			for (const [name, items] of [
				["scenario-build-pending.json", result.pendingBuild],
				["scenario-judge-pending.json", result.pendingJudge],
				["scenario-reformulation-pending.json", result.pendingReformulation],
			] as const) {
				if (!items.length) continue;
				const path = resolve(pendingDir, name);
				writeFileSync(path, JSON.stringify(items, null, 2));
				pendingFiles.push(path);
			}
			const report = {
				ok: result.complete,
				skillFiles,
				mode: "full",
				suite: suite.id,
				searchProfile,
				documentLimit,
				assemblyMode,
				queryReformulationMode: queryReformulation,
				replayNamespace,
				identity: { ...identityFor(), artifactDigests: result.artifactDigests },
				filter,
				status: result.complete ? "complete" : "incomplete",
				tasks: tasks.length,
				scored: result.scores.length,
				meanScore: result.meanScore,
				axisMeans: result.axisMeans,
				mixedAxes: result.mixedAxes,
				statuses: result.statuses,
				scores: result.scores,
				deliveryOutcomes: result.deliveryOutcomes,
				qualityScores: result.qualityScores,
				retrievalFidelityScores: result.retrievalFidelityScores,
				composeScores: result.composeScores,
				absentScores: result.absentScores,
				...(abstentionContrast === "on"
					? { abstentionScores: result.abstentionScores }
					: {}),
				evidenceSupply,
				recordProvenance: result.recordProvenance,
				usage: result.usage,
				pendingFiles,
				...(effectiveReformulation() !== "off" ? { reformulationTraces } : {}),
				searchPreview: result.searchPreview,
				note: result.complete
					? result.mixedAxes
						? "Scores are LLM judgments of skill assembly. Mixed axes: meanScore is withheld; see axisMeans (proposal 34)."
						: "Scores are LLM judgments of skill assembly, not canned fixture verdicts."
					: "Incomplete: meanScore is withheld because not every task was scored.",
			};
			const legacyDefault =
				suite.format === "legacy" &&
				!outputDir &&
				!axis &&
				!queryStyle &&
				searchProfile === "handle" &&
				assemblyMode === "baseline" &&
				effectiveReformulation() === "off" &&
				evidenceSupply === "natural" &&
				abstentionContrast === "off";
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
	}
} finally {
	fixture.close();
}
