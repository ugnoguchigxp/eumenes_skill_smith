/** Paid comparison with current generation over the original absent-axis fixture. */
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
	digest,
	skillDeliverySchema,
	type Build,
	type Ports,
	type SkillDelivery,
	type SourceSearch,
} from "../../src/index.js";
import {
	judgeData,
	parseAnyScenarioSuite,
} from "../../src/eval/scenario-score.js";
import {
	ARCHIVED_ABSENT_JUDGE_INSTRUCTIONS,
	archivedAbsentJudgeOutputSchema,
	archivedAbsentJudgeSchema,
} from "./archived-absent-judge.js";
import { createCloudBudget, type CloudModel } from "./cloud-budget.js";
import { ContextStillFixture } from "./database.js";
import {
	explorationSelectionGuidance,
	installFixedExploration,
} from "./fixed-exploration.js";
import { createExampleHost } from "./host.js";
import { createMcpHandler } from "./mcp.js";
import { savedCloud } from "./saved-cloud.js";
import { seedDatabase } from "./seed.js";
import { createFixtureSource } from "./source.js";
import { writeSkillArtifact } from "./skill-output.js";

const arg = (flag: string) => {
	const i = process.argv.indexOf(flag);
	if (i < 0 || !process.argv[i + 1]) throw Error("missing " + flag);
	return resolve(process.argv[i + 1]!);
};
if (!process.argv.includes("--run")) throw Error("explicit --run required");
const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const tasks = parseAnyScenarioSuite(read(arg("--suite"))).tasks.filter(
	(task) => task.axis === "absent",
);
const settings = read(arg("--settings")) as {
	connectionId: string;
	maxUsd: number;
	minimumAccountedUsd: number;
	judge: CloudModel;
};
const baseline = arg("--baseline");
const journal = arg("--journal");
const out = arg("--out");
if (settings.maxUsd !== 20 || !existsSync(journal))
	throw Error("existing_cumulative_journal_required");
if (tasks.length !== 4 || !existsSync(join(baseline, "complete.json")))
	throw Error("four_completed_baseline_attempts_required");
if (existsSync(join(out, "manifest.json")))
	throw Error("fresh_output_required");
mkdirSync(out, { recursive: true, mode: 0o700 });
function save(name: string, data: unknown) {
	const file = join(out, name);
	writeFileSync(file + ".tmp", JSON.stringify(data, null, 2) + "\n", {
		mode: 0o600,
	});
	renameSync(file + ".tmp", file);
}
type Card = { ref: string; title: string };
type Row = {
	taskId: string;
	durationMs: number;
	reply: SkillDelivery | { kind: "error"; code: string };
	retrieved: Card[];
	strategy: Build["content"]["decision"]["strategy"] | null;
	usedRefs: string[];
	selection?: unknown;
};
const lock = openSync(journal + ".lock", "wx", 0o600);
try {
	const saved = await savedCloud(arg("--host"), settings.connectionId);
	if (!saved.models.includes(settings.judge.id))
		throw Error("model_not_in_catalog");
	const budget = createCloudBudget({
		...saved,
		journal,
		maxUsd: settings.maxUsd,
	});
	const startingUsd = budget.spent();
	if (
		!Number.isFinite(settings.minimumAccountedUsd) ||
		startingUsd + 1e-9 < settings.minimumAccountedUsd
	)
		throw Error("journal_missing_previous_evaluation");
	const startingIds = new Set(budget.events().map((event) => event.id));
	const saveBudget = () =>
		save("budget.json", {
			startingUsd,
			accountedUsd: budget.spent(),
			newEvents: budget.events().filter((event) => !startingIds.has(event.id)),
		});
	const seed = join(out, "seed.sqlite");
	seedDatabase({ destination: seed });
	const fixture = new ContextStillFixture(seed, "handle");
	const token = crypto.randomUUID();
	const source = createFixtureSource(createMcpHandler(fixture, token), token);
	const receipts = new Map<string, string>();
	let retrieved: SourceSearch | undefined;
	let taskId: string;
	const inference: Ports<unknown>["inference"] = {
		validReceipt: (_tx, receipt, requestRef) =>
			receipts.get(receipt) === requestRef,
		async complete(input, signal) {
			if (!retrieved) throw Error("search_required");
			const answer = await budget.complete(
				settings.judge,
				"fixed-exploration:" + taskId + ":selection",
				{
					...input,
					system: input.system + "\n" + explorationSelectionGuidance,
					data: { selection: input.data, search: retrieved },
				},
				signal,
			);
			receipts.set(answer.receipt, input.requestRef);
			return answer;
		},
	};
	const host = createExampleHost(
		source,
		"Explore an unfamiliar task",
		inference,
		{
			assemblyMode: "baseline",
			acceptance: tasks[0]!.acceptance,
			constraints: [],
			candidates: 8,
			documents: 8,
			modelCalls: 1,
			outputTokens: 128,
		},
	);
	const rows: Row[] = [];
	try {
		const { service, artifact } = installFixedExploration(host);
		writeSkillArtifact(join(out, "fixed"), artifact);
		save("manifest.json", {
			version: "fixed-exploration-comparison.v1",
			tasks: tasks.map(({ id, goal, acceptance }) => ({
				id,
				goal,
				acceptance,
			})),
			selectionModel: settings.judge.id,
			judgeModel: settings.judge.id,
			judgeDigest: digest(ARCHIVED_ABSENT_JUDGE_INSTRUCTIONS),
			templateDigest: artifact.bundleDigest,
			searchProfile: "handle",
			selectionGuidance: explorationSelectionGuidance,
			timing:
				"Search, candidate preparation, model selection, binding and exact artifact delivery. Catalog installation is outside the timed request.",
		});
		for (const task of tasks) {
			taskId = task.id;
			retrieved = undefined;
			const request = {
				...host.request,
				requestId: "fixed:" + task.id,
				delivery: "artifact" as const,
				task: {
					...host.request.task,
					goal: task.goal,
					acceptance: task.acceptance,
				},
			};
			const authority = { ...host.authority, searchTask: task.goal };
			const context = {
				signal: AbortSignal.timeout(120000),
				reserve: async () => {},
			};
			const started = performance.now();
			let reply: Row["reply"];
			let selection: unknown;
			try {
				retrieved = await source.search(
					task.goal,
					request.limits.candidates,
					context.signal,
					context,
				);
				const prepared = service.prepareSkillSelection(
					host.db,
					request,
					authority,
				);
				const selected = await service.selectSkill(prepared, context);
				selection = selected.decision;
				if (selected.decision.kind === "miss") {
					reply = {
						contractVersion: "skillsmith.delivery.v1",
						kind: "unavailable",
						code: "selection_miss",
					};
				} else {
					const accepted = host.db.transaction(() =>
						service.bindSkillSelection(host.db, prepared, selected, authority),
					)();
					reply = await service.getSkillDelivery(
						accepted.requestRef!,
						authority,
						(op) => op(host.db),
						context.signal,
						context,
					);
					if (
						reply.kind === "ready" &&
						(reply.skill.content !== artifact.content ||
							reply.skill.bundleDigest !== artifact.bundleDigest)
					)
						throw Error("fixed_template_changed");
				}
			} catch (error) {
				reply = {
					kind: "error",
					code: error instanceof Error ? error.message : "unknown_error",
				};
			}
			rows.push({
				taskId,
				durationMs: performance.now() - started,
				reply,
				retrieved:
					retrieved?.cards.map(({ ref, title }) => ({ ref, title })) ?? [],
				strategy: reply.kind === "ready" ? "provisional" : null,
				usedRefs: [],
				selection,
			});
			console.log(
				JSON.stringify({
					taskId,
					durationMs: rows.at(-1)!.durationMs,
					status: reply.kind,
					selection,
				}),
			);
			save("delivery.json", rows);
			saveBudget();
		}
	} finally {
		host.close();
		fixture.close();
	}
	const baselineRows = read(join(baseline, "outcomes.json")) as {
		taskId: string;
		reply: unknown;
	}[];
	const modelRecords = read(join(baseline, "records.json")) as {
		taskId: string;
		value: Partial<Build["content"]["decision"]>;
		data: { candidateCards?: Card[] };
	}[];
	const grades = [];
	for (const task of tasks) {
		const fixed = rows.find((row) => row.taskId === task.id)!;
		const original = skillDeliverySchema.safeParse(
			baselineRows.find((row) => row.taskId === task.id)?.reply,
		);
		const baselineRecords = modelRecords.filter(
			(row) => row.taskId === task.id,
		);
		const draft = baselineRecords
			.filter((row) => row.value.kind === "ready")
			.at(-1)?.value;
		const candidates =
			baselineRecords.find((row) => row.data.candidateCards)?.data
				.candidateCards ?? [];
		const variants = [
			{
				mode: "baseline",
				reply: original.data,
				strategy: draft?.strategy ?? null,
				usedRefs: draft?.sourceRefs ?? [],
				retrieved: candidates.map(({ ref, title }) => ({ ref, title })),
			},
			{ mode: "fixed", ...fixed },
		];
		for (const variant of variants) {
			if (variant.reply?.kind !== "ready") {
				grades.push({
					taskId: task.id,
					mode: variant.mode,
					grade: null,
					status: "no_artifact",
				});
				continue;
			}
			const { skill } = variant.reply;
			const data = {
				...judgeData({
					task,
					retrievalRank: null,
					retrieved: variant.retrieved,
					usedRefs: variant.usedRefs,
					kind: "ready",
					strategy: variant.strategy,
					sections: [],
					body: skill.content,
				}),
				nearestFalseFriendRefs: task.nearestFalseFriendRefs,
				referenceFiles:
					skill.files?.map(({ path, content }) => ({ path, content })) ?? [],
			};
			try {
				const response = await budget.complete(
					settings.judge,
					"fixed-exploration:" + task.id + ":judge:" + variant.mode,
					{
						system: ARCHIVED_ABSENT_JUDGE_INSTRUCTIONS,
						data,
						schema: archivedAbsentJudgeOutputSchema,
						deadlineAt: Date.now() + 120000,
						maxOutputTokens: 900,
						requestRef: digest(data),
					},
					AbortSignal.timeout(120000),
				);
				grades.push({
					taskId: task.id,
					mode: variant.mode,
					bundleDigest: skill.bundleDigest,
					grade: archivedAbsentJudgeSchema.parse(response.value),
					status: "graded",
				});
			} catch (error) {
				grades.push({
					taskId: task.id,
					mode: variant.mode,
					grade: null,
					status: error instanceof Error ? error.message : "unknown_error",
				});
			} finally {
				save("grades.json", grades);
				saveBudget();
			}
		}
	}
	save("grades.json", grades);
	save("complete.json", {
		delivered: rows.filter((row) => row.reply.kind === "ready").length,
		graded: grades.filter((grade) => grade.grade).length,
	});
} finally {
	closeSync(lock);
	unlinkSync(journal + ".lock");
}
