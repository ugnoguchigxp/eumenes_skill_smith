import { z } from "zod";
// Quality-eval kit entry: audits suite integrity, then compares recorded results.
// Usage: bun examples/contextstill/eval-kit.ts [suite.json] [--require-records]
// Inference records (inputDigest-bound) and comparison result JSON are separate concerns.
// Does not treat the default wiring query 「検証」 as a quality score.
import "../../scripts/test-preload.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	runEvalSuite,
	evalSuiteSchema,
	auditEvalSuite,
	type EvalRunResult,
} from "../../src/eval/index.js";

const args = process.argv.slice(2).filter((a) => a !== "--require-records");
const requireRecords = process.argv.includes("--require-records");
const path = resolve(
	args[0] ?? "examples/contextstill/seed/eval-suite.fixture.json",
);
const suite = evalSuiteSchema.parse(JSON.parse(readFileSync(path, "utf8")));

// Optional companion file: expected digests for tamper detection.
// Shape: { "taskId:condition": "expectedInputDigest", ... }
const digestPath = path.endsWith(".json")
	? path.replace(/\.json$/, ".expected-digests.json")
	: path + ".expected-digests.json";
let expectedDigests: Record<string, string> | undefined;
try {
	expectedDigests = z
		.record(z.string(), z.string().min(1))
		.parse(JSON.parse(readFileSync(digestPath, "utf8")));
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const audit = auditEvalSuite(suite, { expectedDigests, requireRecords });
if (!audit.ok) {
	console.error(JSON.stringify({ ok: false, audit }, null, 2));
	process.exit(1);
}

const { comparisons, synthesisNotClearlyBetter } = await runEvalSuite(
	suite,
	async (task, condition) => {
		// Fixture runner: comparison inputs only; live product/baseline execute is in contract tests.
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
	{ expectedDigests, requireRecords },
);

console.log(
	JSON.stringify(
		{
			ok: true,
			suite: suite.id,
			tasks: suite.tasks.length,
			audit,
			comparisons: comparisons.map((c) => ({
				taskId: c.taskId,
				deltas: c.deltas,
			})),
			synthesisNotClearlyBetter,
			note: "wiring query 検証 is not a quality score; lexicalOverlap is 字面一致 not faithfulness",
		},
		null,
		2,
	),
);
