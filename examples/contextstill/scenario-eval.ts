// Scenario eval: run SkillSmith against seed tasks, then LLM-score assembled skills.
// Usage:
//   bun examples/contextstill/scenario-eval.ts
//   bun examples/contextstill/scenario-eval.ts --build-records path --judge-records path
// Missing records write pending tasks under data/contextstill/ and exit 2.
// This is not context:check (fixed_wiring_stub) and not context:eval (canned fixture JSON).
import "../../scripts/test-preload.js";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ContextStillFixture } from "./database.js";
import { createMcpHandler } from "./mcp.js";
import { createFixtureSource } from "./source.js";
import { createExampleHost } from "./host.js";
import {
	recordedInference,
	type InferenceRecord,
	type InferenceTask,
} from "./recorded.js";
import {
	JUDGE_INSTRUCTIONS,
	assemblyJudgeSchema,
	judgeData,
	judgeOutputSchema,
	retrievalRank,
	scenarioSuiteSchema,
	scoreFromJudge,
	type AssemblyScore,
	type ScenarioTask,
} from "../../src/eval/scenario-score.js";

function arg(name: string, fallback: string) {
	const index = process.argv.indexOf(name);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	return value ? resolve(value) : resolve(fallback);
}

function loadRecords(path: string): InferenceRecord[] {
	if (!existsSync(path)) return [];
	const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
	return Array.isArray(raw) ? (raw as InferenceRecord[]) : [];
}

const suitePath = arg("--suite", "examples/contextstill/scenarios/suite.json");
const dbPath = arg("--db", "data/contextstill/seed.sqlite");
const buildRecordPath = arg(
	"--build-records",
	"examples/contextstill/scenarios/build-records.json",
);
const judgeRecordPath = arg(
	"--judge-records",
	"examples/contextstill/scenarios/judge-records.json",
);
const scorePath = arg(
	"--scores",
	"examples/contextstill/scenarios/scores.json",
);
const pendingDir = resolve("data/contextstill");
const suite = scenarioSuiteSchema.parse(
	JSON.parse(readFileSync(suitePath, "utf8")),
);
const buildRecords = loadRecords(buildRecordPath);
const judgeRecords = loadRecords(judgeRecordPath);
const fixture = new ContextStillFixture(dbPath);
const token = crypto.randomUUID();
const source = createFixtureSource(createMcpHandler(fixture, token), token);
const pendingBuild: { taskId: string; tasks: InferenceTask[] }[] = [];
const pendingJudge: { taskId: string; tasks: InferenceTask[] }[] = [];
const scores: AssemblyScore[] = [];
const searchPreview: {
	taskId: string;
	retrievalRank: number | null;
	retrieved: { ref: string; title: string }[];
}[] = [];

const fixedDeadline = 1_700_000_000_000 + 120_000;

async function runTask(task: ScenarioTask) {
	const search = await source.search(
		task.goal,
		8,
		new AbortController().signal,
	);
	const retrieved = search.cards.map((card) => ({
		ref: card.ref,
		title: card.title,
	}));
	const rank = retrievalRank(search.cards, task.expectedRefs);
	searchPreview.push({
		taskId: task.id,
		retrievalRank: rank,
		retrieved,
	});
	const collected: InferenceTask[] = [];
	const host = createExampleHost(
		source,
		task.goal,
		recordedInference(buildRecords, (item) => collected.push(item)),
		{
			goal: task.goal,
			acceptance: task.acceptance,
			requestId: `scenario:${task.id}`,
			modelCalls: 4,
			candidates: 8,
			documents: 8,
		},
	);
	try {
		const reply = await host.run().catch((error: Error) => {
			if (error.message === "inference_record_missing")
				return { kind: "awaiting_inference" as const };
			throw error;
		});
		if (reply.kind === "awaiting_inference") {
			pendingBuild.push({
				taskId: task.id,
				tasks: collected.filter(
					(item) =>
						!buildRecords.some(
							(record) => record.inputDigest === item.inputDigest,
						),
				),
			});
			return;
		}
		const usedRefs =
			reply.kind === "ready" ? reply.build.content.decision.sourceRefs : [];
		const strategy =
			reply.kind === "ready" ? reply.build.content.decision.strategy : null;
		const sections =
			reply.kind === "ready" ? reply.build.content.decision.sections : [];
		const body = reply.kind === "ready" ? reply.build.content.body : null;
		const missing = reply.kind === "needs_input" ? reply.missing : [];
		const kind =
			reply.kind === "ready" ||
			reply.kind === "needs_input" ||
			reply.kind === "unavailable" ||
			reply.kind === "rejected"
				? reply.kind
				: "error";
		const judgeTasks: InferenceTask[] = [];
		const judge = recordedInference(judgeRecords, (item) =>
			judgeTasks.push(item),
		);
		try {
			const judged = await judge.complete(
				{
					system: JUDGE_INSTRUCTIONS,
					data: judgeData({
						task,
						retrievalRank: rank,
						retrieved,
						usedRefs,
						strategy,
						kind,
						sections,
						body,
						missing,
					}),
					schema: judgeOutputSchema,
					requestRef: `scenario-judge:${task.id}`,
					maxOutputTokens: 400,
					deadlineAt: fixedDeadline,
				},
				new AbortController().signal,
			);
			scores.push(
				scoreFromJudge(
					task,
					{
						retrievalRank: rank,
						usedRefs,
						strategy,
						kind,
					},
					assemblyJudgeSchema.parse(judged.value),
				),
			);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === "inference_record_missing"
			) {
				pendingJudge.push({ taskId: task.id, tasks: judgeTasks });
				return;
			}
			throw error;
		}
	} finally {
		host.close();
	}
}

try {
	for (const task of suite.tasks) await runTask(task);
	mkdirSync(pendingDir, { recursive: true });
	if (pendingBuild.length) {
		const path = resolve(pendingDir, "scenario-build-pending.json");
		writeFileSync(path, JSON.stringify(pendingBuild, null, 2));
		console.log(
			JSON.stringify(
				{
					ok: false,
					status: "awaiting_build_inference",
					pendingFile: path,
					pendingTasks: pendingBuild.map((item) => ({
						taskId: item.taskId,
						inputDigest: item.tasks.at(-1)?.inputDigest ?? null,
					})),
					searchPreview,
				},
				null,
				2,
			),
		);
		process.exitCode = 2;
	} else if (pendingJudge.length) {
		const path = resolve(pendingDir, "scenario-judge-pending.json");
		writeFileSync(path, JSON.stringify(pendingJudge, null, 2));
		console.log(
			JSON.stringify(
				{
					ok: false,
					status: "awaiting_judge",
					pendingFile: path,
					pendingTasks: pendingJudge.map((item) => ({
						taskId: item.taskId,
						inputDigest: item.tasks.at(-1)?.inputDigest ?? null,
					})),
					searchPreview,
				},
				null,
				2,
			),
		);
		process.exitCode = 2;
	} else {
		const report = {
			ok: true,
			suite: suite.id,
			scored: scores.length,
			meanScore:
				scores.reduce((sum, item) => sum + item.score, 0) / scores.length,
			scores,
			searchPreview,
			note: "Scores are LLM judgments of skill assembly, not canned fixture verdicts.",
		};
		writeFileSync(scorePath, JSON.stringify(report, null, 2));
		console.log(JSON.stringify({ ...report, scoreFile: scorePath }, null, 2));
	}
} finally {
	fixture.close();
}
