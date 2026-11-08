/** Offline reproduction and diagnostic extraction, never a successful transport substitute. */
import { resolve, join } from "node:path";
import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdtempSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
const root = resolve(process.argv[2] ?? process.cwd());
await import(root + "/scripts/test-preload.ts");
const { recordedInference } = await import(
	root + "/examples/contextstill/recorded.ts"
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
const { createExampleHost } = await import(
	root + "/examples/contextstill/host.ts"
);
const { seedDatabase } = await import(root + "/examples/contextstill/seed.ts");
const { sqliteRepository } = await import(root + "/src/sqlite/index.ts");
const { bytes, digest } = await import(root + "/src/service/identity.ts");
const { renderSkillMarkdown } = await import(root + "/src/index.ts");
const { contextStillSkillMarkdown } = await import(
	root + "/examples/contextstill/skill-source.ts"
);
const { writeSkillArtifact } = await import(
	root + "/examples/contextstill/skill-output.ts"
);
const base = root + "/artifacts/novel-three-2026-11-08";
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const config = read(root + "/docs/quality/cloud-eval-generation-settings.json");
const suite = read(root + "/docs/quality/novel-three-suite-2026-11-08.json");
const records = read(base + "/records.json");
const original = read(base + "/outcomes.json");
const delivered = read(base + "/skills.json");
const temp = mkdtempSync(join(tmpdir(), "skillsmith-novel-replay-"));
const extracted = {},
	results = [],
	materials = [];
let matchedInputs = 0;
function assert(ok, message) {
	if (!ok) throw Error(message);
}
try {
	const seed = join(temp, "seed.sqlite");
	seedDatabase({ destination: seed });
	const fixture = new ContextStillFixture(seed, "bm25");
	try {
		const token = "offline-novel-replay",
			plain = createFixtureSource(createMcpHandler(fixture, token), token);
		for (const task of suite.tasks) {
			const port = (sample, model) =>
				recordedInference(
					records.filter((r) => r.taskId === task.id),
					() => {
						matchedInputs++;
					},
					undefined,
					{
						providerSettings: {
							provider: "saved-cloud-responses",
							model: model.id,
							generation: {
								adapter: "strict-schema.v4",
								sample,
								reasoningEffort: model.reasoningEffort ?? null,
							},
						},
					},
				);
			const source = createAutoReformulatingSource(
				plain,
				createReformulatingSource(
					plain,
					port("reformulation", config.executor),
					{ deadlineAt: 1_700_000_120_000 },
				),
			);
			const host = createExampleHost(
				source,
				task.goal,
				port("quality-build", config.builder),
				{
					goal: task.goal,
					acceptance: task.acceptance,
					requestId: "scenario:" + task.id,
					modelCalls: 4,
					candidates: 8,
					documents: 8,
					outputTokens: 4000,
					constraints: config.taskConstraints,
					assemblyMode: "baseline",
				},
			);
			try {
				const reply = await host.run();
				const expected = original.find((o) => o.taskId === task.id).reply;
				assert(
					reply.kind === expected.kind && reply.code === expected.code,
					"original_outcome_mismatch",
				);
				const stored = host.db.query("SELECT ref FROM knowledge_builds").all();
				assert(stored.length === 1, "one_completed_build_required");
				const build = sqliteRepository.build(host.db, stored[0].ref);
				assert(build && !build.revoked, "active_build_required");
				const skill = renderSkillMarkdown(
					build.content,
					undefined,
					contextStillSkillMarkdown,
				);
				const review = records.find(
					(r) => r.taskId === task.id && r.data.originalTask,
				);
				assert(
					review?.value.approved === true && !review.value.correction,
					"approved_uncorrected_body_required",
				);
				const item = review.data.untrustedReview.items[0];
				assert(item.artifact === skill.content, "reviewed_main_mismatch");
				assert(
					digest(item.files) === digest(skill.files),
					"reviewed_references_mismatch",
				);
				if (delivered[task.id])
					assert(
						digest(skill) === digest(delivered[task.id]),
						"delivered_artifact_mismatch",
					);
				const inner = {
					contractVersion: "skillsmith.v1",
					requestRef: build.requestRef,
					kind: "ready",
					build,
				};
				const final = { ...inner, skill };
				const row = {
					taskId: task.id,
					originalOutcome: expected.kind,
					replayOutcome: reply.kind,
					code: reply.code ?? null,
					outputLimitBytes: host.request.limits.outputBytes,
					innerReplyBytes: bytes(inner),
					finalReplyBytes: bytes(final),
					mainBytes: Buffer.byteLength(skill.content),
					referenceBytes: (skill.files ?? []).reduce(
						(s, f) => s + Buffer.byteLength(f.content),
						0,
					),
					bundleDigest: skill.bundleDigest,
					usedRefs: build.content.decision.sourceRefs,
					reviewedBodyIdentical: true,
					deliveryAccepted: reply.kind === "ready",
				};
				results.push(row);
				extracted[task.id] = skill;
				// Export the frozen reviewed body for inspection; the failed reply remains failed.
				writeSkillArtifact(
					root + "/docs/quality/novel-skills/2026-11-08",
					skill,
				);
				let verificationEvidence =
					"Semantic review approved the exact body. Separate isolated code execution will be recorded before paid grading. One reply passed delivery and two failed the output-byte cap; judge content only, never relabel delivery as successful.";
				if (existsSync(base + "/example-verification.json")) {
					const sample = read(
						base + "/example-verification.json",
					).examples.find((e) => e.taskId === task.id);
					assert(
						sample?.exitCode === 0 &&
							skill.files.some((f) => f.digest === sample.referenceSha256),
						"fixture_evidence_mismatch",
					);
					verificationEvidence =
						"Exact main and every reference replayed from the frozen 12 API records; semantic review approved unchanged body. Reference code manually inspected and executed with python3 -I: exit 0; " +
						sample.stdout.trim() +
						". This proves only the synthetic fixture. Two original transport replies still failed the 32768-byte limit. Judge document content independently from delivery failure; do not infer production success.";
				}
				materials.push({
					taskId: task.id,
					taskContext: {
						goal: task.goal,
						acceptance: task.acceptance,
						constraints: config.taskConstraints,
					},
					acceptanceCriteria: task.withheldChecks,
					artifactToEvaluate: {
						status: "complete-reviewed-body",
						deliveryStatus: expected.kind,
						deliveryCode: expected.code ?? null,
						main: skill.content,
						files: skill.files,
						bundleDigest: skill.bundleDigest,
					},
					sourceEvidence: item.sources,
					verificationEvidence,
				});
			} finally {
				host.close();
			}
		}
	} finally {
		fixture.close();
	}
	const report = {
		complete: true,
		networkCalls: 0,
		matchedInputs,
		results,
		scope:
			"Original reply statuses reproduced without changing the 32768-byte cap. Three exact reviewed bodies extracted for inspection; this does not turn failed delivery into a pass. Replay time is not generation time.",
	};
	writeFileSync(
		base + "/reviewed-skills.json",
		JSON.stringify(extracted, null, 2) + "\n",
	);
	writeFileSync(
		base + "/grading-materials.json",
		JSON.stringify(materials, null, 2) + "\n",
	);
	writeFileSync(
		base + "/replay-and-bytes.json",
		JSON.stringify(report, null, 2) + "\n",
	);
	console.log(JSON.stringify(report));
} finally {
	rmSync(temp, { recursive: true, force: true });
}
