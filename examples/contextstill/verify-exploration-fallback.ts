/** Opt-in cloud verification of the SDK selector and exact authored bundle. */
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
	createSkillSmith,
	digest,
	skillDeliverySchema,
	type Ports,
	type SkillDelivery,
	type Usage,
} from "../../src/index.js";
import { sqliteApprovedSkills } from "../../src/sqlite/index.js";
import {
	ARCHIVED_ABSENT_JUDGE_INSTRUCTIONS,
	archivedAbsentJudgeOutputSchema,
	archivedAbsentJudgeSchema,
} from "./archived-absent-judge.js";
import { createCloudBudget, type CloudModel } from "./cloud-budget.js";
import { createExampleHost } from "./host.js";
import { savedCloud } from "./saved-cloud.js";
import { writeSkillArtifact } from "./skill-output.js";

const arg = (flag: string) => {
	const index = process.argv.indexOf(flag);
	if (index < 0 || !process.argv[index + 1]) throw Error("missing " + flag);
	return resolve(process.argv[index + 1]!);
};
if (!process.argv.includes("--run")) throw Error("explicit --run required");
const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const suite = z
	.object({
		protocol: z.string(),
		tasks: z.array(
			z.object({
				id: z.string(),
				goal: z.string(),
				acceptance: z.array(z.object({ id: z.string(), text: z.string() })),
				expected: z.enum(["explore", "miss"]),
			}),
		),
	})
	.parse(read(arg("--suite")));
const settings = read(arg("--settings")) as {
	connectionId: string;
	maxUsd: number;
	minimumAccountedUsd: number;
	judge: CloudModel;
};
const out = arg("--out"),
	journal = arg("--journal");
if (settings.maxUsd !== 20 || !existsSync(journal))
	throw Error("existing_cumulative_journal_required");
if (existsSync(join(out, "manifest.json")))
	throw Error("fresh_output_required");
mkdirSync(out, { recursive: true, mode: 0o700 });
const save = (name: string, data: unknown) =>
	writeFileSync(join(out, name), JSON.stringify(data, null, 2) + "\n", {
		mode: 0o600,
	});
const lock = openSync(journal + ".lock", "wx", 0o600);
try {
	const saved = await savedCloud(arg("--host"), settings.connectionId);
	const model = settings.judge;
	if (!saved.models.includes(model.id)) throw Error("model_not_in_catalog");
	const budget = createCloudBudget({
		...saved,
		maxUsd: settings.maxUsd,
		journal,
	});
	const startingUsd = budget.spent();
	if (
		!Number.isFinite(settings.minimumAccountedUsd) ||
		startingUsd + 1e-9 < settings.minimumAccountedUsd
	)
		throw Error("journal_missing_previous_evaluation");
	const startIds = new Set(budget.events().map((event) => event.id));
	const saveUsage = () =>
		save("budget.json", {
			startingUsd,
			accountedUsd: budget.spent(),
			events: budget.events().filter((event) => !startIds.has(event.id)),
		});
	const priorTemplate = readFileSync(arg("--template"), "utf8");
	save("manifest.json", {
		suiteDigest: digest(suite),
		protocol: suite.protocol,
		model: model.id,
		judgeDigest: digest(ARCHIVED_ABSENT_JUDGE_INSTRUCTIONS),
		templateDigest: digest(priorTemplate),
	});
	const receipts = new Map<string, string>();
	let taskId = "";
	const inference: Ports<unknown>["inference"] = {
		validReceipt: (_tx, receipt, request) => receipts.get(receipt) === request,
		async complete(input, signal) {
			const answer = await budget.complete(
				model,
				"sdk-exploration:" + taskId + ":selection",
				input,
				signal,
			);
			receipts.set(answer.receipt, input.requestRef);
			return answer;
		},
	};
	const unexpectedSource = async () => {
		throw Error("unexpected_source_call");
	};
	const host = createExampleHost(
		{
			search: unexpectedSource,
			get: unexpectedSource,
			validate: unexpectedSource,
		},
		"",
		inference,
		{
			assemblyMode: "baseline",
			constraints: [],
			modelCalls: 1,
			outputTokens: 128,
		},
	);
	const service = createSkillSmith({
		...host.ports,
		now: Date.now,
		explorationFallback: true,
		approvedSkills: sqliteApprovedSkills({
			authorizePublication: () => false,
			approvalCurrent: () => false,
		}),
	});
	const { searchTask: _searchTask, ...authority } = host.authority;
	const rows: {
		taskId: string;
		expected: string;
		durationMs: number;
		status: string;
		code?: string;
		usage?: Usage;
		skill?: Extract<SkillDelivery, { kind: "ready" }>["skill"];
	}[] = [];
	try {
		for (const task of suite.tasks) {
			taskId = task.id;
			const request = {
				...host.request,
				requestId: "exploration:" + task.id,
				delivery: "artifact" as const,
				task: {
					...host.request.task,
					goal: task.goal,
					acceptance: task.acceptance,
				},
				limits: { ...host.request.limits, deadlineAt: Date.now() + 120000 },
			};
			const context = {
				signal: AbortSignal.timeout(120000),
				reserve: async () => {},
			};
			const start = performance.now();
			let status = "error",
				code: string | undefined,
				usage: Usage | undefined,
				skill: (typeof rows)[number]["skill"];
			try {
				const prepared = service.prepareSkillSelection(
					host.db,
					request,
					authority,
				);
				const selection = await service.selectSkill(prepared, context);
				status = selection.decision.kind;
				usage = selection.usage;
				if (selection.decision.kind !== "miss") {
					const accepted = host.db.transaction(() =>
						service.bindSkillSelection(host.db, prepared, selection, authority),
					)();
					const packet = skillDeliverySchema.parse(
						await service.getSkillDelivery(
							accepted.requestRef!,
							authority,
							(op) => op(host.db),
							context.signal,
							context,
						),
					);
					status = packet.kind;
					if (packet.kind === "ready") {
						if (!packet.exploration || packet.skill.content !== priorTemplate)
							throw Error("unexpected_artifact");
						skill = packet.skill;
					} else if ("code" in packet) code = packet.code;
				}
			} catch (error) {
				status = "error";
				code = error instanceof Error ? error.message : "unknown_error";
			}
			const durationMs = performance.now() - start;
			if (skill) writeSkillArtifact(join(out, "skill"), skill);
			rows.push({
				taskId,
				expected: task.expected,
				durationMs,
				status,
				code,
				usage,
				skill,
			});
			save("delivery.json", rows);
			saveUsage();
			console.log(JSON.stringify({ taskId, durationMs, status, code, usage }));
		}
	} finally {
		host.close();
	}
	const grades = [];
	for (const row of rows) {
		if (row.expected !== "explore" || !row.skill) continue;
		const task = suite.tasks.find((item) => item.id === row.taskId)!;
		const data = {
			task: {
				id: task.id,
				axis: "absent",
				goal: task.goal,
				acceptance: task.acceptance,
				expectedRefs: [],
				expectedTitles: [],
			},
			retrievalRank: null,
			retrieved: [],
			assembled: {
				kind: "ready",
				strategy: "provisional",
				usedRefs: [],
				sections: [],
				body: row.skill.content,
				missing: [],
			},
			nearestFalseFriendRefs: [],
			referenceFiles: [],
		};
		for (let repeat = 1; repeat <= 3; repeat++) {
			try {
				const answer = await budget.complete(
					model,
					"sdk-exploration:" + task.id + ":grade:" + repeat,
					{
						system: ARCHIVED_ABSENT_JUDGE_INSTRUCTIONS,
						data,
						schema: archivedAbsentJudgeOutputSchema,
						maxOutputTokens: 900,
						deadlineAt: Date.now() + 120000,
						requestRef: digest(data),
					},
					AbortSignal.timeout(120000),
				);
				const grade = archivedAbsentJudgeSchema.parse(answer.value);
				grades.push({ taskId: task.id, repeat, grade });
				console.log(
					JSON.stringify({ taskId: task.id, repeat, score: grade.score }),
				);
			} catch (error) {
				grades.push({
					taskId: task.id,
					repeat,
					grade: null,
					code: error instanceof Error ? error.message : "unknown_error",
				});
			} finally {
				save("grades.json", grades);
				saveUsage();
			}
		}
	}
	save("complete.json", {
		attempted: rows.length,
		graded: grades.filter((row) => row.grade).length,
	});
} finally {
	closeSync(lock);
	unlinkSync(journal + ".lock");
}
