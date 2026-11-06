// Quality-eval kit entry: replays recorded-inference records through proposal 01 suite schema.
// Usage: bun examples/contextstill/eval-kit.ts [suite.json]
// Does not treat the default wiring query 「検証」 as a quality score.
import "../../scripts/test-preload.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	runEvalSuite,
	evalSuiteSchema,
	type EvalRunResult,
} from "../../src/eval/index.js";

const path = resolve(
	process.argv[2] ?? "examples/contextstill/seed/eval-suite.fixture.json",
);
const suite = evalSuiteSchema.parse(JSON.parse(readFileSync(path, "utf8")));

const { comparisons, synthesisNotClearlyBetter } = await runEvalSuite(
	suite,
	async (task, condition) => {
		// Fixture runner: records are comparison inputs only; no live inference here.
		const pack = suite.records.find(
			(r) => r.taskId === task.id && r.condition === condition,
		);
		const canned = pack?.records[0]?.value as
			Partial<EvalRunResult> | undefined;
		return {
			taskId: task.id,
			condition,
			kind: (canned?.kind as EvalRunResult["kind"]) ?? "ready",
			usedRefs: canned?.usedRefs ?? [],
			inputTokens: canned?.inputTokens ?? null,
			outputTokens: canned?.outputTokens ?? null,
			modelCalls: canned?.modelCalls ?? 0,
			sourceCalls: canned?.sourceCalls ?? 0,
			judgment: canned?.judgment,
		};
	},
);

console.log(
	JSON.stringify(
		{
			suite: suite.id,
			tasks: suite.tasks.length,
			comparisons: comparisons.map((c) => ({
				taskId: c.taskId,
				deltas: c.deltas,
			})),
			synthesisNotClearlyBetter,
			note: "wiring query 検証 is not a quality score",
		},
		null,
		2,
	),
);
