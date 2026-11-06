// Proposal 26/35: two-mode scenario runner (retrieval-only / full) over typed three-axis tasks.
// retrieval-only calls SourcePort.search only and never creates inference; it invents no 0-10 scores.
// Proposal 35: per-task isolation, status vocabulary, run identity, record provenance, measured usage only.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { multiQueryDigests } from "./multi-query.js";
import type { SearchProfile } from "./database.js";
import { createExampleHost } from "./host.js";
import type { SourcePort } from "./source.js";
import {
	COMPOSE_JUDGE_INSTRUCTIONS,
	composeJudgeSchema,
	composeJudgeOutputSchema,
	composeJudgeDigests,
	oracleEvidenceSource,
	type EvidenceSupply,
} from "./compose-isolation.js";
import {
	ABSENT_JUDGE_INSTRUCTIONS,
	absentJudgeSchema,
	absentJudgeOutputSchema,
	absentJudgeDigests,
} from "./absent-isolation.js";
import {
	ABSTENTION_JUDGE_INSTRUCTIONS,
	abstentionJudgeSchema,
	abstentionJudgeOutputSchema,
	abstentionJudgeDigests,
	expectedRefsRetrieved,
	type AbstentionContrast,
} from "./abstention-isolation.js";
import type {
	InferenceTask,
	RecordContext,
	recordedInference,
} from "./recorded.js";
import {
	reformulationDigests,
	type QueryReformulation,
} from "./query-reformulation.js";
import { digest } from "../../src/index.js";
import {
	buildInstructions,
	compactBuildInstructions,
} from "../../src/instructions/build.js";
import {
	JUDGE_INSTRUCTIONS,
	allRequiredHit,
	assemblyJudgeSchema,
	builderView,
	judgeData,
	judgeOutputSchema,
	refRanks,
	retrievalRank,
	scoreFromJudge,
	type AssemblyScore,
	type NormalizedScenarioTask,
} from "../../src/eval/scenario-score.js";

type Inference = ReturnType<typeof recordedInference>;

/** Strict CLI profile parsing; omitted means the product default bm25 (handle stays explicit). */
export function parseSearchProfile(argv: string[]): SearchProfile {
	const index = argv.indexOf("--search-profile");
	if (index < 0) return "bm25";
	const value = argv[index + 1];
	if (value !== "handle" && value !== "bm25")
		throw new Error(`unknown --search-profile ${value ?? "(missing)"}`);
	return value;
}

export type AssemblyMode = "baseline" | "compact";

/** Strict CLI assembly-mode parsing; omitted means baseline (recorded-inference compatible). */
export function parseAssemblyMode(argv: string[]): AssemblyMode {
	const index = argv.indexOf("--assembly-mode");
	if (index < 0) return "baseline";
	const value = argv[index + 1];
	if (value !== "baseline" && value !== "compact")
		throw new Error(`unknown --assembly-mode ${value ?? "(missing)"}`);
	return value;
}

/** SourcePort API cap; ranks past it are unobservable here. */
export const SEARCH_LIMIT = 20;
/** Product disclosure window (candidates/documents) and the legacy rank cutoff. */
export const PRIMARY_K = 8;

export interface RetrievalRow {
	taskId: string;
	axis: NormalizedScenarioTask["axis"];
	queryStyle: NormalizedScenarioTask["queryStyle"];
	tags: string[];
	/** Per expected ref, 1-based rank within top SEARCH_LIMIT; null = not returned. */
	ranks: { ref: string; rank: number | null }[];
	/** null = N/A (absent axis: nothing expected). */
	allRequiredHitAt8: boolean | null;
	/** Diagnostic only: limited by SEARCH_LIMIT, not the product's 8-card window. */
	allRequiredHitAt20Diagnostic: boolean | null;
	/** Absent axis watch-list refs seen in top 8 (lexical near misses, not gold). */
	falseFriendsInTop8: string[];
	top8: { ref: string; title: string }[];
	/** Set when source.search failed for this task; later tasks still run. */
	error?: string;
}

function rate(
	rows: RetrievalRow[],
	key: "allRequiredHitAt8" | "allRequiredHitAt20Diagnostic",
) {
	const scored = rows.filter((row) => row[key] !== null);
	return {
		hit: scored.filter((row) => row[key] === true).length,
		of: scored.length,
		notApplicable: rows.length - scored.length,
	};
}

export function summarizeRetrieval(rows: RetrievalRow[]) {
	const groups = new Map<string, RetrievalRow[]>();
	for (const row of rows) {
		const key = row.tags.includes("comparison-slice")
			? "comparison-slice"
			: row.axis === "retrieval"
				? `retrieval:${row.queryStyle}`
				: row.axis;
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}
	return Object.fromEntries(
		[...groups].map(([key, items]) => [
			key,
			{
				tasks: items.length,
				allRequiredHitAt8: rate(items, "allRequiredHitAt8"),
				allRequiredHitAt20Diagnostic: rate(
					items,
					"allRequiredHitAt20Diagnostic",
				),
			},
		]),
	);
}

/** Optional proposals 28/29 auxiliary-inference ledger; absent when reformulation is off. */
export interface ReformulationLedger {
	/** Returns and clears InferenceTasks the reformulation port requested since the last drain. */
	drain: () => InferenceTask[];
	hasRecord: (digest: string) => boolean;
}

export interface PendingReformulation {
	taskId: string;
	tasks: InferenceTask[];
}

export async function runRetrievalOnly(
	tasks: NormalizedScenarioTask[],
	source: SourcePort,
	reformulation?: ReformulationLedger,
	pending: PendingReformulation[] = [],
): Promise<RetrievalRow[]> {
	const rows: RetrievalRow[] = [];
	for (const task of tasks) {
		try {
			const { cards } = await source.search(
				task.goal,
				SEARCH_LIMIT,
				new AbortController().signal,
			);
			const ranks = refRanks(cards, task.expectedRefs);
			const top8 = cards.slice(0, PRIMARY_K);
			const watch = new Set(task.nearestFalseFriendRefs);
			rows.push({
				taskId: task.id,
				axis: task.axis,
				queryStyle: task.queryStyle,
				tags: task.tags,
				ranks,
				allRequiredHitAt8: allRequiredHit(ranks, PRIMARY_K),
				allRequiredHitAt20Diagnostic: allRequiredHit(ranks, SEARCH_LIMIT),
				falseFriendsInTop8: top8
					.map((c) => c.ref)
					.filter((ref) => watch.has(ref)),
				top8: top8.map((c) => ({ ref: c.ref, title: c.title })),
			});
		} catch (error) {
			rows.push({
				taskId: task.id,
				axis: task.axis,
				queryStyle: task.queryStyle,
				tags: task.tags,
				ranks: task.expectedRefs.map((ref) => ({ ref, rank: null })),
				allRequiredHitAt8: null,
				allRequiredHitAt20Diagnostic: null,
				falseFriendsInTop8: [],
				top8: [],
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			if (reformulation) {
				const missing = reformulation
					.drain()
					.filter((item) => !reformulation.hasRecord(item.inputDigest));
				if (missing.length) pending.push({ taskId: task.id, tasks: missing });
			}
		}
	}
	return rows;
}

export type TaskStatus =
	| "scored"
	| "awaiting_build_inference"
	| "awaiting_reformulation_inference"
	| "awaiting_judge"
	| "invalid"
	| "error";

/** Binds a report to suite/seed bytes and the instruction/schema digests that shaped records. */
export interface RunIdentity {
	searchProfile: SearchProfile;
	assemblyMode: AssemblyMode;
	evidenceSupply: EvidenceSupply;
	composeJudgeInstructionsDigest: string;
	composeJudgeSchemaDigest: string;
	/** Proposal 32 absent-axis judge; additive identity fields. */
	absentJudgeInstructionsDigest: string;
	absentJudgeSchemaDigest: string;
	/** Proposal 33 opt-in contrast judge; additive identity fields. */
	abstentionContrast: AbstentionContrast;
	abstentionJudgeInstructionsDigest: string;
	abstentionJudgeSchemaDigest: string;
	/** Proposals 28/29 opt-in; records with and without it must not mix. */
	queryReformulation: QueryReformulation;
	reformulationInstructionsDigest: string | null;
	reformulationSchemaDigest: string | null;
	suiteId: string;
	suiteFileSha256: string;
	seedFileSha256: string;
	buildInstructionsDigest: string;
	judgeInstructionsDigest: string;
	judgeSchemaDigest: string;
}

export function instructionDigests(assemblyMode: AssemblyMode = "baseline") {
	return {
		buildInstructionsDigest: digest(
			assemblyMode === "compact" ? compactBuildInstructions : buildInstructions,
		),
		judgeInstructionsDigest: digest(JUDGE_INSTRUCTIONS),
		judgeSchemaDigest: digest(judgeOutputSchema),
	};
}

function fileSha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** SHA-256 of suite/seed file bytes plus digest() of builder/judge instructions and judge schema. */
export function buildEvalIdentity(input: {
	searchProfile: SearchProfile;
	suiteId: string;
	suitePath: string;
	seedPath: string;
	assemblyMode?: AssemblyMode;
	queryReformulation?: QueryReformulation;
	evidenceSupply?: EvidenceSupply;
	abstentionContrast?: AbstentionContrast;
}): RunIdentity {
	const assemblyMode = input.assemblyMode ?? "baseline";
	const queryReformulation = input.queryReformulation ?? "off";
	return {
		searchProfile: input.searchProfile,
		evidenceSupply: input.evidenceSupply ?? "natural",
		...composeJudgeDigests(),
		...absentJudgeDigests(),
		abstentionContrast: input.abstentionContrast ?? "off",
		...abstentionJudgeDigests(),
		assemblyMode,
		queryReformulation,
		...(queryReformulation === "on"
			? reformulationDigests()
			: queryReformulation === "multi"
				? multiQueryDigests()
				: {
						reformulationInstructionsDigest: null,
						reformulationSchemaDigest: null,
					}),
		suiteId: input.suiteId,
		suiteFileSha256: fileSha256(input.suitePath),
		seedFileSha256: fileSha256(input.seedPath),
		...instructionDigests(assemblyMode),
	};
}

export interface RecordProvenance {
	taskId: string;
	/** Digests the builder inference actually requested for this task. */
	builderInputDigests: string[];
	/** Judge digest once requested; null if the judge was not reached. */
	judgeInputDigest: string | null;
	/** True when every requested builder digest had a matching record. */
	builderRecordsPresent: boolean;
	/** True/false once a judge digest was requested; null if judge not reached. */
	judgeRecordPresent: boolean | null;
}

export interface RunUsage {
	/** Collected builder InferenceTask count (measured). */
	buildInferenceTasks: number;
	/** Collected judge InferenceTask count (measured). */
	judgeInferenceTasks: number;
	/** Proposals 28/29 auxiliary reformulation InferenceTask count (measured; 0 only when off/never called). */
	reformulationInferenceTasks: number;
	/** recordedInference leaves tokens null; never coerce to 0. */
	inputTokens: null;
	outputTokens: null;
	/** Eval-only document reads for oracle cards and compose judge reference bodies. */
	evalEvidenceGetCalls: number;
}

export interface FullDeps {
	tasks: NormalizedScenarioTask[];
	source: SourcePort;
	/** Called per task for build and judge; records decide replay. */
	createInference: (
		role: "build" | "judge",
		onTask: (task: InferenceTask) => void,
		/** Replay namespace only; must not be sent to the builder model. */
		recordContext?: RecordContext,
	) => Inference;
	hasBuildRecord: (digest: string) => boolean;
	/** Opt-in compact assembly (proposal 36). Default baseline. */
	assemblyMode?: AssemblyMode;
	evidenceSupply?: EvidenceSupply;
	/** Proposal 33: judge tasks with expectedRefs by the contrast judge. Default off. */
	abstentionContrast?: AbstentionContrast;
	/** Proposal 28 ledger; present only when the source is the reformulating wrapper. */
	reformulation?: ReformulationLedger;
}

const fixedDeadline = 1_700_000_000_000 + 120_000;

export async function runFull(deps: FullDeps) {
	const statuses: {
		taskId: string;
		axis: string;
		status: TaskStatus;
		detail?: string;
	}[] = [];
	const pendingBuild: { taskId: string; tasks: InferenceTask[] }[] = [];
	const pendingJudge: { taskId: string; tasks: InferenceTask[] }[] = [];
	const scores: AssemblyScore[] = [];
	const composeScores: {
		taskId: string;
		coverage: number;
		coherence: number;
		conflictHandling: number;
		actionability: number;
	}[] = [];
	const absentScores: {
		taskId: string;
		boundedExploration: number;
		inventsOfficialSkill: boolean;
		claimsVerified: boolean;
		actionability: number;
	}[] = [];
	const abstentionScores: {
		taskId: string;
		expectedRefsRetrieved: string[];
		treatsExistingAsAbsent: boolean;
		excessiveAbstention: boolean;
		appropriateGap: boolean;
	}[] = [];
	let evalEvidenceGetCalls = 0;
	const searchPreview: {
		taskId: string;
		retrievalRank: number | null;
		ranks: { ref: string; rank: number | null }[];
		allRequiredHitAt8: boolean | null;
		retrieved: { ref: string; title: string }[];
	}[] = [];
	const recordProvenance: RecordProvenance[] = [];
	const pendingReformulation: PendingReformulation[] = [];
	let reformulationInferenceTasks = 0;
	const drainReformulation = (taskId: string) => {
		const ledger = deps.reformulation;
		if (!ledger) return;
		const items = ledger.drain();
		reformulationInferenceTasks += items.length;
		const missing = items.filter((item) => !ledger.hasRecord(item.inputDigest));
		if (missing.length) pendingReformulation.push({ taskId, tasks: missing });
	};
	let buildInferenceTasks = 0;
	let judgeInferenceTasks = 0;
	const assemblyMode = deps.assemblyMode ?? "baseline";
	const evidenceSupply = deps.evidenceSupply ?? "natural";
	const recordContext =
		evidenceSupply === "oracle" ? ({ evidenceSupply } as const) : undefined;
	for (const task of deps.tasks) {
		const status = (s: TaskStatus, detail?: string) =>
			statuses.push({
				taskId: task.id,
				axis: task.axis,
				status: s,
				...(detail ? { detail } : {}),
			});
		const provenance: RecordProvenance = {
			taskId: task.id,
			builderInputDigests: [],
			judgeInputDigest: null,
			builderRecordsPresent: false,
			judgeRecordPresent: null,
		};
		recordProvenance.push(provenance);
		try {
			const taskSource =
				evidenceSupply === "oracle"
					? await oracleEvidenceSource(
							deps.source,
							task.expectedRefs,
							new AbortController().signal,
							() => {
								evalEvidenceGetCalls++;
							},
						)
					: deps.source;
			const search = await taskSource.search(
				task.goal,
				PRIMARY_K,
				new AbortController().signal,
			);
			const retrieved = search.cards.map((card) => ({
				ref: card.ref,
				title: card.title,
			}));
			const rank = retrievalRank(search.cards, task.expectedRefs);
			const ranks = refRanks(search.cards, task.expectedRefs);
			searchPreview.push({
				taskId: task.id,
				retrievalRank: rank,
				ranks,
				allRequiredHitAt8: allRequiredHit(ranks, PRIMARY_K),
				retrieved,
			});
			const collected: InferenceTask[] = [];
			const view = builderView(task);
			const host = createExampleHost(
				taskSource,
				view.goal,
				deps.createInference(
					"build",
					(item) => {
						collected.push(item);
						provenance.builderInputDigests.push(item.inputDigest);
					},
					recordContext,
				),
				{
					goal: view.goal,
					acceptance: view.acceptance,
					requestId: `scenario:${task.id}`,
					modelCalls: 4,
					candidates: 8,
					documents: 8,
					assemblyMode,
				},
			);
			try {
				const reply = await host.run().catch((error: Error) => {
					if (error.message === "inference_record_missing")
						return { kind: "awaiting_inference" as const };
					throw error;
				});
				buildInferenceTasks += collected.length;
				provenance.builderRecordsPresent =
					collected.length > 0 &&
					collected.every((item) => deps.hasBuildRecord(item.inputDigest));
				if (reply.kind === "awaiting_inference") {
					pendingBuild.push({
						taskId: task.id,
						tasks: collected.filter(
							(item) => !deps.hasBuildRecord(item.inputDigest),
						),
					});
					status("awaiting_build_inference");
					continue;
				}
				const ready = reply.kind === "ready" ? reply : null;
				const usedRefs = ready ? ready.build.content.decision.sourceRefs : [];
				const strategy = ready ? ready.build.content.decision.strategy : null;
				const sections = ready ? ready.build.content.decision.sections : [];
				const body = ready ? ready.build.content.body : null;
				const missing = reply.kind === "needs_input" ? reply.missing : [];
				const kind =
					reply.kind === "ready" ||
					reply.kind === "needs_input" ||
					reply.kind === "unavailable" ||
					reply.kind === "rejected"
						? reply.kind
						: "error";
				const judgeTasks: InferenceTask[] = [];
				const judge = deps.createInference(
					"judge",
					(item) => {
						judgeTasks.push(item);
						provenance.judgeInputDigest = item.inputDigest;
					},
					recordContext,
				);
				try {
					const compose = task.axis === "compose";
					const absent = task.axis === "absent";
					// Proposal 33 opt-in: only tasks whose skill exists in the fixture.
					const contrast =
						deps.abstentionContrast === "on" && task.expectedRefs.length > 0;
					const contrastRetrieved = expectedRefsRetrieved(
						task.expectedRefs,
						retrieved,
					);
					// Judge-only ground truth documents; never inserted into builder task/data.
					const referenceEvidence = [];
					if (compose)
						for (const ref of task.expectedRefs) {
							evalEvidenceGetCalls++;
							const doc = await deps.source.get(
								ref,
								new AbortController().signal,
							);
							referenceEvidence.push({
								ref: doc.ref,
								title: doc.title,
								body: doc.body,
							});
						}
					const data = judgeData({
						task,
						retrievalRank: rank,
						retrieved,
						usedRefs,
						strategy,
						kind,
						sections,
						body,
						missing,
					});
					const judged = await judge.complete(
						{
							system: contrast
								? ABSTENTION_JUDGE_INSTRUCTIONS
								: absent
									? ABSENT_JUDGE_INSTRUCTIONS
									: compose
										? COMPOSE_JUDGE_INSTRUCTIONS
										: JUDGE_INSTRUCTIONS,
							data: contrast
								? { ...data, expectedRefsRetrieved: contrastRetrieved }
								: absent
									? {
											...data,
											// Watch-list only; not gold and never sent to the builder.
											nearestFalseFriendRefs: task.nearestFalseFriendRefs,
										}
									: compose
										? { ...data, evidenceSupply, referenceEvidence }
										: data,
							schema: contrast
								? abstentionJudgeOutputSchema
								: absent
									? absentJudgeOutputSchema
									: compose
										? composeJudgeOutputSchema
										: judgeOutputSchema,
							requestRef: `scenario-judge:${task.id}`,
							maxOutputTokens: contrast || absent || compose ? 1200 : 400,
							deadlineAt: fixedDeadline,
						},
						new AbortController().signal,
					);
					judgeInferenceTasks += judgeTasks.length;
					provenance.judgeRecordPresent = true;
					const parsed = (
						contrast
							? abstentionJudgeSchema
							: absent
								? absentJudgeSchema
								: compose
									? composeJudgeSchema
									: assemblyJudgeSchema
					).safeParse(judged.value);
					if (!parsed.success) {
						status(
							"invalid",
							parsed.error.issues[0]?.message ?? "judge_schema_invalid",
						);
						continue;
					}
					if (contrast) {
						const detailed = abstentionJudgeSchema.parse(judged.value);
						abstentionScores.push({
							taskId: task.id,
							expectedRefsRetrieved: contrastRetrieved,
							treatsExistingAsAbsent: detailed.treatsExistingAsAbsent,
							excessiveAbstention: detailed.excessiveAbstention,
							appropriateGap: detailed.appropriateGap,
						});
					} else if (compose) {
						const detailed = composeJudgeSchema.parse(judged.value);
						composeScores.push({
							taskId: task.id,
							coverage: detailed.coverage,
							coherence: detailed.coherence,
							conflictHandling: detailed.conflictHandling,
							actionability: detailed.actionability,
						});
					}
					if (absent) {
						const detailed = absentJudgeSchema.parse(judged.value);
						absentScores.push({
							taskId: task.id,
							boundedExploration: detailed.boundedExploration,
							inventsOfficialSkill: detailed.inventsOfficialSkill,
							claimsVerified: detailed.claimsVerified,
							actionability: detailed.actionability,
						});
					}
					scores.push(
						scoreFromJudge(
							task,
							{ retrievalRank: rank, usedRefs, strategy, kind },
							parsed.data,
						),
					);
					status("scored");
				} catch (error) {
					judgeInferenceTasks += judgeTasks.length;
					if (
						error instanceof Error &&
						error.message === "inference_record_missing"
					) {
						provenance.judgeRecordPresent = false;
						pendingJudge.push({ taskId: task.id, tasks: judgeTasks });
						status("awaiting_judge");
						continue;
					}
					status(
						"error",
						error instanceof Error ? error.message : String(error),
					);
				}
			} finally {
				host.close();
			}
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === "reformulation_record_missing"
			)
				status("awaiting_reformulation_inference");
			else
				status("error", error instanceof Error ? error.message : String(error));
		} finally {
			drainReformulation(task.id);
		}
	}
	const complete = statuses.every((s) => s.status === "scored");
	const usage: RunUsage = {
		buildInferenceTasks,
		judgeInferenceTasks,
		reformulationInferenceTasks,
		inputTokens: null,
		outputTokens: null,
		evalEvidenceGetCalls,
	};
	return {
		complete,
		evidenceSupply,
		composeScores,
		absentScores,
		abstentionScores,
		statuses,
		scores,
		pendingBuild,
		pendingJudge,
		pendingReformulation,
		searchPreview,
		recordProvenance,
		usage,
		instructionDigests: instructionDigests(assemblyMode),
		...axisSpecificMeans(statuses, scores, complete),
	};
}

export type AxisName = "retrieval" | "compose" | "absent";
export type AxisMeans = Record<AxisName, number | null>;

/**
 * Proposal 34: per-axis judges have different rubrics, so a mixed-axis run never
 * publishes one blended mean. An axis mean is published only when every task of
 * that axis in the run was scored (and at least one exists); otherwise null.
 * meanScore keeps the legacy single-axis average and is null when the run's
 * tasks span more than one axis or the run is incomplete.
 */
export function axisSpecificMeans(
	statuses: readonly { taskId: string; axis: string; status: TaskStatus }[],
	scores: readonly { taskId: string; score: number }[],
	complete: boolean,
): { meanScore: number | null; axisMeans: AxisMeans; mixedAxes: boolean } {
	const axisOf = new Map(statuses.map((s) => [s.taskId, s.axis]));
	const axes = new Set(statuses.map((s) => s.axis));
	const mean = (items: readonly { score: number }[]) =>
		items.reduce((sum, item) => sum + item.score, 0) / items.length;
	const axisMeans = Object.fromEntries(
		(["retrieval", "compose", "absent"] as const).map((axis) => {
			const all = statuses.filter((s) => s.axis === axis);
			const scored = scores.filter((s) => axisOf.get(s.taskId) === axis);
			const ok =
				all.length > 0 &&
				all.every((s) => s.status === "scored") &&
				scored.length === all.length;
			return [axis, ok ? mean(scored) : null];
		}),
	) as AxisMeans;
	const mixedAxes = axes.size > 1;
	return {
		/** Only defined when every task scored and all share one axis. */
		meanScore: complete && scores.length && !mixedAxes ? mean(scores) : null,
		axisMeans,
		mixedAxes,
	};
}
