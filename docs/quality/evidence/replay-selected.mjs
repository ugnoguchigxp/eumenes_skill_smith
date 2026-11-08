import { resolve } from "node:path";
import { existsSync } from "node:fs";
const root = resolve(process.argv[2] ?? process.cwd());
await import(root + "/scripts/test-preload.ts");
const { recordedInference, inferenceTask } = await import(
	root + "/examples/contextstill/recorded.ts"
);
const { runFull } = await import(
	root + "/examples/contextstill/scenario-runner.ts"
);
const { ContextStillFixture } = await import(
	root + "/examples/contextstill/database.ts"
);
const { createFixtureSource } = await import(
	root + "/examples/contextstill/source.ts"
);
const { createMcpHandler } = await import(
	root + "/examples/contextstill/mcp.ts"
);
const { createReformulatingSource, createAutoReformulatingSource } =
	await import(root + "/examples/contextstill/query-reformulation.ts");
const { digest } = await import(root + "/src/index.ts");
const { seedDatabase } = await import(root + "/examples/contextstill/seed.ts");
const base = root + "/artifacts/generation-scoped-2026-11-08";
const config = await Bun.file(
	root + "/docs/quality/cloud-eval-generation-settings.json",
).json();
const suite = await Bun.file(
	root + "/docs/quality/practical-suite.json",
).json();
const records = await Bun.file(base + "/records.json").json(),
	failures = await Bun.file(base + "/failures.json").json();
const expected = await Bun.file(base + "/skills.json").json(),
	original = await Bun.file(base + "/quality.json").json();
let matchedInputs = 0;
const port = (purpose, model, onTask = () => {}, context = undefined) => {
	const options = {
		providerSettings: {
			provider: "saved-cloud-responses",
			model: model.id,
			generation: {
				adapter: "strict-schema.v4",
				sample: purpose,
				reasoningEffort: model.reasoningEffort ?? null,
			},
		},
	};
	const replay = recordedInference(records, onTask, context, options);
	return {
		validReceipt: replay.validReceipt,
		complete: async (raw, signal) => {
			const input = structuredClone(raw);
			if (purpose === "quality-judge") {
				const task = suite.tasks.find(
					(t) => input.requestRef === "scenario-judge:" + t.id,
				);
				if (task)
					input.data.untrustedJudgeData.data.task.acceptance =
						task.withheldChecks;
			}
			const task = inferenceTask(input, context, options);
			if (failures[task.inputDigest]) {
				matchedInputs++;
				throw Error(failures[task.inputDigest]);
			}
			if (records.some((r) => r.inputDigest === task.inputDigest))
				matchedInputs++;
			return replay.complete(input, signal);
		},
	};
};
if (!existsSync(base + "/seed.sqlite"))
	seedDatabase({ destination: base + "/seed.sqlite" });
const fixture = new ContextStillFixture(base + "/seed.sqlite", "bm25");
try {
	const token = crypto.randomUUID(),
		plain = createFixtureSource(createMcpHandler(fixture, token), token);
	const source = createAutoReformulatingSource(
		plain,
		createReformulatingSource(plain, port("reformulation", config.executor), {
			deadlineAt: 1700000120000,
		}),
	);
	const actual = {};
	const result = await runFull({
		tasks: suite.tasks.map((t) => ({
			...t,
			legacy: null,
			nearestFalseFriendRefs: [],
		})),
		source,
		outputTokens: config.outputTokens,
		constraints: config.taskConstraints,
		createInference: (role, onTask, context) =>
			port(
				role === "build" ? "quality-build" : "quality-judge",
				role === "build" ? config.builder : config.judge,
				onTask,
				context,
			),
		hasBuildRecord: (id) => records.some((r) => r.inputDigest === id),
		onSkill: (id, skill) => {
			actual[id] = skill;
		},
	});
	const expectedDigests = expected;
	const report = {
		networkForbidden: true,
		listenerForbidden: true,
		matchedInputs,
		statusesMatch: digest(result.statuses) === digest(original.statuses),
		deliveriesMatch:
			digest(result.deliveryOutcomes) === digest(original.deliveryOutcomes),
		artifactDigestsMatch: digest(actual) === digest(expectedDigests),
		artifactCount: Object.keys(actual).length,
		fullArtifactsCompared: true,
		artifacts: Object.fromEntries(
			Object.entries(actual).map(([id, s]) => [
				id,
				{
					main: s.digest,
					bundle: s.bundleDigest,
					files: (s.files ?? []).map((f) => ({
						path: f.path,
						digest: f.digest,
					})),
				},
			]),
		),
		statuses: result.statuses,
		limits:
			"Exact current inference identities for the selected condition; no new provider outputs or quality grades.",
	};
	await Bun.write(
		base + "/current-replay.json",
		JSON.stringify(report, null, 2) + "\n",
	);
	console.log(
		JSON.stringify({
			matchedInputs,
			statusesMatch: report.statusesMatch,
			deliveriesMatch: report.deliveriesMatch,
			artifactDigestsMatch: report.artifactDigestsMatch,
			artifactCount: report.artifactCount,
		}),
	);
	if (
		!report.statusesMatch ||
		!report.deliveriesMatch ||
		!report.artifactDigestsMatch
	)
		process.exitCode = 1;
} finally {
	fixture.close();
}
