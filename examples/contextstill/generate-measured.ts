/** One-shot measured generation, using the frozen common host and cumulative cloud journal. */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	renameSync,
	openSync,
	closeSync,
	rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
	digest,
	requestSchema,
	INSTRUCTION_VERSION,
	type Ports,
	type SkillArtifact,
} from "../../src/index.js";
import { scenarioTaskSchema } from "../../src/eval/scenario-score.js";
import { createCloudBudget, type CloudModel } from "./cloud-budget.js";
import { savedCloud } from "./saved-cloud.js";
import { inferenceTask } from "./recorded.js";
import { seedDatabase } from "./seed.js";
import { ContextStillFixture } from "./database.js";
import { createFixtureSource } from "./source.js";
import { createMcpHandler } from "./mcp.js";
import {
	createReformulatingSource,
	createAutoReformulatingSource,
} from "./query-reformulation.js";
import { createExampleHost } from "./host.js";
import { writeSkillArtifact } from "./skill-output.js";

const arg = (name: string) => {
	const i = process.argv.indexOf(name);
	if (i < 0 || !process.argv[i + 1]) throw Error("missing " + name);
	return resolve(process.argv[i + 1]!);
};
if (!process.argv.includes("--run")) throw Error("explicit --run required");
const suitePath = arg("--suite"),
	settingsPath = arg("--settings"),
	out = arg("--out"),
	journal = arg("--journal");
const rawSuite: unknown = JSON.parse(readFileSync(suitePath, "utf8"));
const suite = z
	.object({
		id: z.string().min(1),
		tasks: z
			.array(
				scenarioTaskSchema.pick({ id: true, goal: true, acceptance: true }),
			)
			.min(1)
			.max(32),
	})
	.parse(rawSuite);
if (new Set(suite.tasks.map((t) => t.id)).size !== suite.tasks.length)
	throw Error("duplicate_task_id");
const config = JSON.parse(readFileSync(settingsPath, "utf8")) as {
	maxUsd: number;
	builder: CloudModel;
	executor: CloudModel;
	connectionId: string;
	outputTokens: number;
	taskConstraints: unknown;
};
if (config.maxUsd !== 15 || config.outputTokens !== 4000)
	throw Error("generation_contract_changed");
const constraints = requestSchema.shape.task.shape.constraints.parse(
	config.taskConstraints,
);
if (!existsSync(journal)) throw Error("existing_cumulative_journal_required");
if (existsSync(join(out, "manifest.json")))
	throw Error("fresh_output_required_no_silent_retries");
mkdirSync(out, { recursive: true, mode: 0o700 });
const save = (name: string, data: unknown) => {
	const path = join(out, name);
	writeFileSync(path + ".tmp", JSON.stringify(data, null, 2) + "\n", {
		mode: 0o600,
	});
	renameSync(path + ".tmp", path);
};
const lock = openSync(journal + ".lock", "wx", 0o600);
try {
	const preparationStart = performance.now();
	const saved = await savedCloud(arg("--host"), config.connectionId);
	for (const model of [config.builder, config.executor])
		if (!saved.models.includes(model.id)) throw Error("model_not_in_catalog");
	let activeTaskId = "";
	const fragments: unknown[] = [];
	const budget = createCloudBudget({
		...saved,
		journal,
		maxUsd: config.maxUsd,
		onIncomplete: (event) => {
			fragments.push({ taskId: activeTaskId, ...event });
			save("incomplete-responses.json", fragments);
		},
	});
	const startingEvents = budget.events().map((e) => e.id);
	save("manifest.json", {
		version: "measured-generation.v1",
		instructionVersion: INSTRUCTION_VERSION,
		suiteDigest: digest(rawSuite),
		settingsDigest: digest(config),
		inputTokens: "provider usage only, unknown stays null",
		outputTokens: config.outputTokens,
		modelCalls: 4,
		sourceCalls: 12,
		candidates: 8,
		documents: 8,
		providerDeadlineMs: 120000,
		workers: 1,
		assemblyMode: "baseline",
		evidenceSupply: "natural",
		searchProfile: "bm25",
		startingAccountedUsd: budget.spent(),
		startingEventIds: startingEvents,
		generatedAt: new Date().toISOString(),
		timing:
			"performance.now; host creation through validated delivery; preparation and judging separate; no streaming/TTFT measurement",
		hiddenCriteriaInBuilder: false,
		retryPolicy:
			"one fresh execution per task; no cross-run inference reuse or retry",
	});
	const dbPath = join(out, "seed.sqlite");
	seedDatabase({ destination: dbPath });
	const fixture = new ContextStillFixture(dbPath, "bm25");
	try {
		const token = crypto.randomUUID();
		const plain = createFixtureSource(createMcpHandler(fixture, token), token);
		const records: unknown[] = [],
			failedInputs: unknown[] = [],
			apiCalls: unknown[] = [],
			outcomes: unknown[] = [],
			timings: unknown[] = [];
		const skills: Record<string, SkillArtifact> = {};
		const preparationMs = performance.now() - preparationStart;
		const batchStart = performance.now();
		type Inference = Ports<unknown>["inference"];
		function inference(
			taskId: string,
			sample: string,
			model: CloudModel,
		): Inference {
			const receipts = new Set<string>();
			const deadline = Date.now() + 120000;
			return {
				validReceipt: (_tx, receipt) => receipts.has(receipt),
				complete: async (input, signal) => {
					const task = inferenceTask(input, undefined, {
						providerSettings: {
							provider: "saved-cloud-responses",
							model: model.id,
							generation: {
								adapter: "strict-schema.v4",
								sample,
								reasoningEffort: model.reasoningEffort ?? null,
							},
						},
					});
					const start = performance.now(),
						startedAt = new Date().toISOString();
					try {
						const answer = await budget.complete(
							model,
							"novel:" + taskId + ":" + sample,
							input,
							AbortSignal.any([
								signal,
								AbortSignal.timeout(Math.max(1, deadline - Date.now())),
							]),
						);
						const durationMs = performance.now() - start;
						receipts.add(answer.receipt);
						records.push({
							...task,
							...answer,
							taskId,
							provider: "saved-cloud-responses",
						});
						apiCalls.push({
							taskId,
							sample,
							model: model.id,
							inputDigest: task.inputDigest,
							startedAt,
							durationMs,
							receipt: answer.receipt,
							status: "completed",
						});
						save("records.json", records);
						return answer;
					} catch (error) {
						const code =
							error instanceof Error &&
							/^cloud_[a-zA-Z0-9_.-]+$/.test(error.message)
								? error.message
								: "cloud_provider_failure";
						failedInputs.push({ ...task, taskId, code });
						apiCalls.push({
							taskId,
							sample,
							model: model.id,
							inputDigest: task.inputDigest,
							startedAt,
							durationMs: performance.now() - start,
							status: "error",
							code,
						});
						save("failed-inputs.json", failedInputs);
						throw Error(code);
					} finally {
						save("api-timings.json", apiCalls);
					}
				},
			};
		}
		for (const task of suite.tasks) {
			activeTaskId = task.id;
			const source = createAutoReformulatingSource(
				plain,
				createReformulatingSource(
					plain,
					inference(task.id, "reformulation", config.executor),
					{ deadlineAt: 1_700_000_120_000 },
				),
			);
			const model = inference(task.id, "quality-build", config.builder);
			const startedAt = new Date().toISOString(),
				start = performance.now();
			let host: ReturnType<typeof createExampleHost> | undefined;
			try {
				host = createExampleHost(source, task.goal, model, {
					goal: task.goal,
					acceptance: task.acceptance,
					requestId: "scenario:" + task.id,
					modelCalls: 4,
					candidates: 8,
					documents: 8,
					outputTokens: config.outputTokens,
					constraints,
					assemblyMode: "baseline",
				});
				const reply = await host.run();
				const durationMs = performance.now() - start;
				timings.push({
					taskId: task.id,
					startedAt,
					endedAt: new Date().toISOString(),
					durationMs,
					status: reply.kind,
				});
				outcomes.push({ taskId: task.id, reply, callLedger: host.callLedger });
				if (reply.kind === "ready") {
					skills[task.id] = reply.skill;
					writeSkillArtifact(join(out, "skills", task.id), reply.skill);
					save("skills.json", skills);
				}
			} catch (error) {
				const code =
					error instanceof Error && /^[a-zA-Z0-9_.-]+$/.test(error.message)
						? error.message
						: "generation_failure";
				timings.push({
					taskId: task.id,
					startedAt,
					endedAt: new Date().toISOString(),
					durationMs: performance.now() - start,
					status: "error",
					code,
				});
				outcomes.push({
					taskId: task.id,
					reply: { kind: "error", code },
					callLedger: host?.callLedger ?? [],
				});
				if (/^cloud_cost_|^cloud_http_/.test(code)) throw error;
			} finally {
				host?.close();
				save("outcomes.json", outcomes);
				save("timings.json", {
					preparationMs,
					batchDurationMs: performance.now() - batchStart,
					tasks: timings,
				});
				save("budget.json", {
					accountedUsd: budget.spent(),
					maxUsd: config.maxUsd,
					newEvents: budget
						.events()
						.filter((e) => !startingEvents.includes(e.id)),
				});
			}
			console.log(
				JSON.stringify({
					taskId: task.id,
					timing: timings.at(-1),
					completed: Object.keys(skills).length,
					accountedUsd: budget.spent(),
				}),
			);
		}
		save("complete.json", {
			attempted: suite.tasks.length,
			ready: Object.keys(skills).length,
			timingCaptured: timings.length,
			complete: Object.keys(skills).length === suite.tasks.length,
		});
	} finally {
		fixture.close();
	}
} finally {
	closeSync(lock);
	rmSync(journal + ".lock", { force: true });
}
