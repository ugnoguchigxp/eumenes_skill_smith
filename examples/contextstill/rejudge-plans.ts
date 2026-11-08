/** Opt-in regrading of frozen responses; never regenerates responses or changes acceptance criteria. */
import { z } from "zod";
import {
	readFileSync,
	writeFileSync,
	existsSync,
	openSync,
	closeSync,
	rmSync,
	renameSync,
	mkdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { digest } from "../../src/index.js";
import { createCloudBudget, type CloudModel } from "./cloud-budget.js";
import { savedCloud } from "./saved-cloud.js";
import {
	planJudgeSystem,
	planJudgmentSchema,
	planJudgeData,
} from "./plan-judge.js";

const arg = (name: string) => {
	const i = process.argv.indexOf(name);
	if (i < 0 || !process.argv[i + 1]) throw Error("missing " + name);
	return resolve(process.argv[i + 1]!);
};
if (!process.argv.includes("--run")) throw Error("explicit --run required");
const config = JSON.parse(readFileSync(arg("--settings"), "utf8")) as {
	connectionId: string;
	maxUsd: number;
	judge: CloudModel;
	taskConstraints?: unknown;
};
if (config.maxUsd !== 10) throw Error("budget_contract_changed");
const suite = JSON.parse(readFileSync(arg("--suite"), "utf8")) as {
	tasks: { id: string; goal: string; withheldChecks: unknown }[];
};
type Run = {
	taskId: string;
	condition: string;
	repeat: number;
	kind: string;
	body: string;
};
const calibration = process.argv.includes("--calibration");
const inputs = JSON.parse(readFileSync(arg("--inputs"), "utf8")) as Run[];
const out = arg("--out"),
	journal = arg("--journal");
const capIndex = process.argv.indexOf("--output-tokens");
const outputTokens = capIndex < 0 ? 900 : Number(process.argv[capIndex + 1]);
if (
	!Number.isSafeInteger(outputTokens) ||
	outputTokens < 1 ||
	outputTokens > 8192
)
	throw Error("invalid_judge_output_limit");
mkdirSync(out, { recursive: true, mode: 0o700 });
const save = (name: string, data: unknown) => {
	const file = join(out, name);
	writeFileSync(file + ".tmp", JSON.stringify(data, null, 2) + "\n", {
		mode: 0o600,
	});
	renameSync(file + ".tmp", file);
};
const manifest = {
	version: "plan-response-judge.v2",
	system: planJudgeSystem,
	systemDigest: digest(planJudgeSystem),
	schemaDigest: digest(z.toJSONSchema(planJudgmentSchema)),
	inputsDigest: digest(inputs),
	suiteDigest: digest(suite),
	settingsDigest: digest(config),
	model: config.judge,
	outputTokens,
	calibration,
	limits:
		"Frozen answers/criteria; independent LLM grading, not human labels or real task execution. Original judgments retained separately.",
};
const priorManifest = join(out, "manifest.json");
if (
	existsSync(priorManifest) &&
	digest(JSON.parse(readFileSync(priorManifest, "utf8"))) !== digest(manifest)
)
	throw Error("rejudge_manifest_mismatch");
const lock = openSync(journal + ".lock", "wx", 0o600);
try {
	save("manifest.json", manifest);
	const saved = await savedCloud(arg("--host"), config.connectionId);
	if (!saved.models.includes(config.judge.id))
		throw Error("judge_not_in_catalog");
	const budget = createCloudBudget({
		...saved,
		maxUsd: config.maxUsd,
		journal,
	});
	type Result = {
		id: string;
		requestDigest: string;
		input: unknown;
		response: unknown;
	};
	const file = join(out, "records.json");
	const records: Result[] = existsSync(file)
		? JSON.parse(readFileSync(file, "utf8"))
		: [];
	let next = 0;
	const settled = await Promise.allSettled(
		Array.from({ length: 4 }, async () => {
			while (next < inputs.length) {
				const run = inputs[next++]!;
				const id = [run.taskId, run.repeat, run.condition].join(":");
				if (records.some((r) => r.id === id)) continue;
				const task = suite.tasks.find((t) => t.id === run.taskId);
				if (!task) throw Error("rejudge_task_missing");
				const input = {
					system: planJudgeSystem,
					data: planJudgeData(
						{ goal: task.goal, constraints: config.taskConstraints },
						task.withheldChecks,
						{ kind: run.kind, text: run.body },
					),
					schema: z.toJSONSchema(planJudgmentSchema),
					requestRef: "rejudge:" + id,
					deadlineAt: Date.now() + 120000,
					maxOutputTokens: outputTokens,
				};
				const response = await budget.complete(
					config.judge,
					(calibration ? "judge-calibration.v2:" : "rejudge.v2:") + id,
					input,
					AbortSignal.timeout(120000),
				);
				planJudgmentSchema.parse(response.value);
				records.push({ id, requestDigest: digest(input), input, response });
				save("records.json", records);
				console.log(
					JSON.stringify({
						completed: records.length,
						total: inputs.length,
						accountedUsd: budget.spent(),
					}),
				);
			}
		}),
	);
	save("budget.json", {
		accountedUsd: budget.spent(),
		limitUsd: config.maxUsd,
	});
	const failed = settled.find((s) => s.status === "rejected");
	if (failed?.status === "rejected") throw failed.reason;
	save("complete.json", {
		complete: records.length === inputs.length,
		records: records.length,
	});
} finally {
	closeSync(lock);
	rmSync(journal + ".lock", { force: true });
}
