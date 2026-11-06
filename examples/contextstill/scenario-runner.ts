// Proposal 26: two-mode scenario runner (retrieval-only / full) over typed three-axis tasks.
// retrieval-only calls SourcePort.search only and never creates inference; it invents no 0-10 scores.
import type { SearchProfile } from "./database.js";

import { createExampleHost } from "./host.js";
import type { SourcePort } from "./source.js";
import type { InferenceTask, recordedInference } from "./recorded.js";

type Inference = ReturnType<typeof recordedInference>;
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

/** Strict CLI profile parsing; omitted means the replay-compatible baseline. */
export function parseSearchProfile(argv: string[]): SearchProfile {
	const index = argv.indexOf("--search-profile");
	if (index < 0) return "handle";
	const value = argv[index + 1];
	if (value !== "handle" && value !== "bm25")
		throw new Error(`unknown --search-profile ${value ?? "(missing)"}`);
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

export async function runRetrievalOnly(
	tasks: NormalizedScenarioTask[],
	source: SourcePort,
): Promise<RetrievalRow[]> {
	const rows: RetrievalRow[] = [];
	for (const task of tasks) {
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
	}
	return rows;
}

export type TaskStatus =
	"scored" | "awaiting_build_inference" | "awaiting_judge" | "error";

export interface FullDeps {
	tasks: NormalizedScenarioTask[];
	source: SourcePort;
	/** Called per task for build and judge; records decide replay. */
	createInference: (
		role: "build" | "judge",
		onTask: (task: InferenceTask) => void,
	) => Inference;
	hasBuildRecord: (digest: string) => boolean;
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
	const searchPreview: {
		taskId: string;
		retrievalRank: number | null;
		ranks: { ref: string; rank: number | null }[];
		allRequiredHitAt8: boolean | null;
		retrieved: { ref: string; title: string }[];
	}[] = [];
	for (const task of deps.tasks) {
		const status = (s: TaskStatus, detail?: string) =>
			statuses.push({
				taskId: task.id,
				axis: task.axis,
				status: s,
				...(detail ? { detail } : {}),
			});
		const search = await deps.source.search(
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
			deps.source,
			view.goal,
			deps.createInference("build", (item) => collected.push(item)),
			{
				goal: view.goal,
				acceptance: view.acceptance,
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
			const judge = deps.createInference("judge", (item) =>
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
						{ retrievalRank: rank, usedRefs, strategy, kind },
						assemblyJudgeSchema.parse(judged.value),
					),
				);
				status("scored");
			} catch (error) {
				if (
					error instanceof Error &&
					error.message === "inference_record_missing"
				) {
					pendingJudge.push({ taskId: task.id, tasks: judgeTasks });
					status("awaiting_judge");
					continue;
				}
				status("error", error instanceof Error ? error.message : String(error));
			}
		} catch (error) {
			status("error", error instanceof Error ? error.message : String(error));
		} finally {
			host.close();
		}
	}
	const complete = statuses.every((s) => s.status === "scored");
	return {
		complete,
		statuses,
		scores,
		pendingBuild,
		pendingJudge,
		searchPreview,
		/** Only defined when every task scored; a partial mean would hide failures. */
		meanScore:
			complete && scores.length
				? scores.reduce((sum, item) => sum + item.score, 0) / scores.length
				: null,
	};
}
