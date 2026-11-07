import { requireThat } from "../service/identity.js";
import {
	evalComparisonSchema,
	evalRunResultSchema,
	type EvalComparison,
	type EvalCondition,
	type EvalRunResult,
} from "./task.js";

function labeled(
	run: EvalRunResult | undefined,
	key: "acceptanceMet" | "misApplied",
): boolean | undefined {
	return run?.judgment?.[key];
}

/**
 * Compare up to three condition runs for one task.
 * Does not declare SkillSmith the winner; encodes falsification-friendly deltas.
 */
export function compareConditionRuns(runs: EvalRunResult[]): EvalComparison {
	requireThat(runs.length >= 1 && runs.length <= 3, "eval_run_count");
	const parsed = runs.map((r) => evalRunResultSchema.parse(r));
	requireThat(
		new Set(parsed.map((r) => r.condition)).size === parsed.length,
		"eval_duplicate_condition",
	);
	const by = Object.fromEntries(parsed.map((r) => [r.condition, r])) as Partial<
		Record<EvalCondition, EvalRunResult>
	>;
	const baseline = by.agent_skills;
	const skillsmith = by.skillsmith;
	const none = by.none;
	const taskId = parsed[0]!.taskId;
	for (const r of parsed) {
		if (r.taskId !== taskId) throw new Error("eval_task_mismatch");
	}

	const acceptanceAdvantage = (() => {
		const s = labeled(skillsmith, "acceptanceMet");
		const b = labeled(baseline, "acceptanceMet");
		if (s === undefined || b === undefined) return "incomplete" as const;
		if (s === b) return "tie" as const;
		return s && !b ? ("skillsmith" as const) : ("agent_skills" as const);
	})();

	const misApplicationWorse = (() => {
		const s = labeled(skillsmith, "misApplied");
		const b = labeled(baseline, "misApplied");
		if (s === undefined || b === undefined) return "incomplete" as const;
		if (s === b) return "tie" as const;
		// "worse" names the condition with more mis-application
		return s && !b ? ("skillsmith" as const) : ("agent_skills" as const);
	})();

	const tokenSum = (r: EvalRunResult | undefined) => {
		if (!r) return null;
		if (r.inputTokens === null || r.outputTokens === null) return null;
		return r.inputTokens + r.outputTokens;
	};
	const sTok = tokenSum(skillsmith);
	const bTok = tokenSum(baseline);
	const tokenDeltaSkillsmithVsBaseline =
		sTok === null || bTok === null ? null : sTok - bTok;

	const acceptanceAdvantageVsNone = (() => {
		const s = labeled(skillsmith, "acceptanceMet");
		const n = labeled(none, "acceptanceMet");
		if (s === undefined || n === undefined) return "incomplete" as const;
		if (s === n) return "tie" as const;
		return s && !n ? ("skillsmith" as const) : ("none" as const);
	})();

	const strategyCounts = {
		reuse: 0,
		adapt: 0,
		compose: 0,
		provisional: 0,
	};
	for (const r of parsed) {
		if (!r.actualStrategy) continue;
		strategyCounts[r.actualStrategy]++;
	}

	let needsInputRuns = 0,
		labeledAppropriate = 0,
		labeledExcessive = 0,
		unlabeled = 0;
	for (const r of parsed) {
		if (r.kind !== "needs_input") continue;
		needsInputRuns++;
		if (r.abstention?.appropriate === true) labeledAppropriate++;
		else if (r.abstention?.excessive === true) labeledExcessive++;
		else unlabeled++;
	}

	return evalComparisonSchema.parse({
		taskId,
		runs: parsed,
		deltas: {
			acceptanceAdvantage,
			acceptanceAdvantageVsNone,
			misApplicationWorse,
			tokenDeltaSkillsmithVsBaseline,
			strategyCounts,
			abstention: {
				needsInputRuns,
				labeledAppropriate,
				labeledExcessive,
				unlabeled,
			},
		},
	});
}

/** Falsification helper: true when synthesis does not clearly beat the baseline. */
export function synthesisNotClearlyBetter(comparison: EvalComparison): boolean {
	const { acceptanceAdvantage, misApplicationWorse } = comparison.deltas;
	if (
		acceptanceAdvantage === "incomplete" ||
		misApplicationWorse === "incomplete"
	)
		return true;
	if (acceptanceAdvantage !== "skillsmith") return true;
	if (misApplicationWorse === "skillsmith") return true;
	return false;
}
