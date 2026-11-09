/** Opt-in evaluation of new requests over independently reviewed, frozen procedures. */
import { Database } from "bun:sqlite";
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
import {
	createSkillSmith,
	assembleApprovedParts,
	digest,
	renderSkillMarkdown,
	type ApprovedSkill,
	type ApprovedComposition,
	type Evidence,
	type GuidanceRequest,
	type Ports,
	type Prepared,
} from "../../src/index.js";
import { migrations, sqliteApprovedSkills } from "../../src/sqlite/index.js";
import { buildContent } from "../../src/service/build.js";
import { publicationDigest } from "../../src/service/approved-publication.js";
import { createCloudBudget, type CloudModel } from "./cloud-budget.js";
import { ContextStillFixture } from "./database.js";
import { createExampleHost } from "./host.js";
import { createMcpHandler } from "./mcp.js";
import { savedCloud } from "./saved-cloud.js";
import { seedDatabase } from "./seed.js";
import { createFixtureSource } from "./source.js";

type Task = Pick<GuidanceRequest["task"], "goal" | "acceptance"> & {
	id: string;
	withheldChecks: GuidanceRequest["task"]["acceptance"];
	parts: string[];
};
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const arg = (flag: string) => {
	const index = process.argv.indexOf(flag);
	if (index < 0 || !process.argv[index + 1]) throw Error("missing " + flag);
	return resolve(process.argv[index + 1]!);
};
if (!process.argv.includes("--run")) throw Error("explicit --run required");
const suite = readJson(arg("--suite")) as {
	id: string;
	tasks: Task[];
	negative: Omit<Task, "parts" | "withheldChecks">;
};
const settings = readJson(arg("--settings")) as {
	connectionId: string;
	maxUsd: number;
	minimumAccountedUsd: number;
	judge: CloudModel;
	executor: CloudModel;
	reviewer?: CloudModel;
	taskConstraints: GuidanceRequest["task"]["constraints"];
};
const library = arg("--library");
const additionalNegatives: (typeof suite.negative)[] = process.argv.flatMap(
	(flag, index) =>
		flag === "--additional-negative"
			? [readJson(resolve(process.argv[index + 1]!))]
			: [],
);
const journal = arg("--journal");
const out = arg("--out");
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
	const seed = join(out, "seed.sqlite");
	seedDatabase({ destination: seed });
	const fixture = new ContextStillFixture(seed, "bm25");
	const token = crypto.randomUUID();
	const source = createFixtureSource(createMcpHandler(fixture, token), token);
	const host = createExampleHost(
		source,
		"approved source validation",
		undefined,
		{
			assemblyMode: "lean",
		},
	);
	const db = new Database(join(out, "approved.sqlite"));
	for (const migration of migrations) db.exec(migration.sql);
	try {
		const parts: ApprovedSkill[] = [];
		const archived = [
			"first-generation-lean-2026-11-09",
			"first-generation-followup-final-2026-11-09",
			"catalog-holdout-2026-11-09",
		].map((run) => {
			const path = join(library, run);
			return {
				records: readJson(join(path, "records.json")),
				outcomes: readJson(join(path, "outcomes.json")),
				version: readJson(join(path, "manifest.json")).instructionVersion,
			};
		});
		const now = Date.now();
		for (const task of suite.tasks)
			for (const id of task.parts) {
				const archive = archived.find((run) =>
					run.outcomes.some(
						(entry: any) => entry.taskId === id && entry.reply.kind === "ready",
					),
				);
				if (!archive?.version) throw Error("missing_frozen_origin:" + id);
				const rows = archive.records.filter(
					(entry: any) => entry.taskId === id,
				);
				const draft = rows.findLast(
					(entry: any) => entry.value?.kind === "ready",
				);
				const review = rows.findLast(
					(entry: any) => entry.value?.approved === true,
				);
				const reviewed = review?.data.untrustedReview.items[0];
				if (!draft || !reviewed) throw Error("missing_frozen_review:" + id);
				const {
					task: originalTask,
					environment,
					audience,
					policy,
				} = draft.data;
				const prepared = {
					record: {
						authority: host.authority,
						request: {
							...host.request,
							task: originalTask,
							environment,
							audience,
						},
					},
					policy,
				} as Prepared;
				const decision = {
					...draft.value,
					...(review.value.sourceReview
						? {
								sourceReview: review.value.sourceReview,
								nonSourceAdditions: review.value.nonSourceAdditions,
							}
						: {}),
				};
				const content = buildContent(
					prepared,
					decision,
					reviewed.sources as Evidence[],
				);
				const artifact = renderSkillMarkdown(content);
				const frozen = archive.outcomes.find(
					(entry: any) => entry.taskId === id,
				).reply.skill;
				if (
					artifact.content !== frozen.content ||
					artifact.bundleDigest !== frozen.bundleDigest ||
					digest(artifact.files) !== digest(frozen.files)
				)
					throw Error("frozen_artifact_mismatch:" + id);
				const part: ApprovedSkill = {
					ref: "approved:" + id,
					scope: host.authority.scope,
					digest: "pending",
					approvalRef: "evaluation-only:" + id,
					applicability: decision.description,
					compositionGroup: task.id,
					artifact: {
						...artifact,
						files: artifact.files!,
						bundleDigest: artifact.bundleDigest!,
					},
					template: {
						ref: "origin:" + id,
						requestRef: "request:" + id,
						scope: host.authority.scope,
						key: id,
						digest: digest(content),
						content,
						generator: {
							instructions: archive.version,
							contractVersion: "skillsmith.v1",
						},
						createdAt: now,
						expiresAt: now + 600000,
						revoked: false,
						usage: {
							modelCalls: 0,
							sourceCalls: 0,
							inputTokens: null,
							outputTokens: null,
							reasoningTokens: null,
							cachedInputTokens: null,
						},
					},
					expiresAt: now + 600000,
				};
				part.digest = publicationDigest(part);
				parts.push(part);
			}
		const approvals = new Set(parts.map((part) => part.digest));
		const requestFor = (
			task: typeof suite.negative,
		): ApprovedComposition["request"] => ({
			task: {
				goal: task.goal,
				acceptance: task.acceptance,
				constraints: settings.taskConstraints,
				references: [],
			},
			environment: host.request.environment,
			audience: host.request.audience,
		});
		// Evaluation-owner attestations of exact ordered bundles and task contracts.
		// These establish the auth boundary, independently of the model's verdict.
		const approvedCompositions = new Set(
			suite.tasks.map((task) => {
				const request = requestFor(task);
				const members = task.parts.map((id) =>
					parts.find((part) => part.ref === "approved:" + id)!,
				);
				const { artifact } = assembleApprovedParts(request, members);
				return digest({
					request,
					parts: members.map(({ ref, digest }) => ({ ref, digest })),
					bundleDigest: artifact.bundleDigest,
				} satisfies ApprovedComposition);
			}),
		);
		const store = sqliteApprovedSkills({
			authorizePublication: () => false,
			approvalCurrent: (_tx, record) => approvals.has(record.digest),
			compositionCurrent: (_tx, auth, composition) =>
				auth.scope === host.authority.scope &&
				approvedCompositions.has(digest(composition)),
		});
		db.transaction(() => {
			for (const part of parts) store.put(db, part);
		})();
		const saved = await savedCloud(arg("--host"), settings.connectionId);
		const model = settings.judge;
		const reviewer = settings.reviewer ?? settings.executor;
		if (!saved.models.includes(model.id) || !saved.models.includes(reviewer.id))
			throw Error("selection_model_unavailable");
		const budget = createCloudBudget({
			...saved,
			journal,
			maxUsd: settings.maxUsd,
		});
		const startingUsd = budget.spent(),
			startingIds = new Set(budget.events().map((entry) => entry.id));
		if (
			!Number.isFinite(settings.minimumAccountedUsd) ||
			startingUsd + 1e-9 < settings.minimumAccountedUsd
		)
			throw Error("journal_missing_previous_evaluation");
		const manifest = {
			suiteDigest: digest(suite),
			additionalNegatives: additionalNegatives.map(digest),
			model: model.id,
			reviewer: reviewer.id,
			initialUsd: startingUsd,
			repeats: 3,
			compositionApprovals: [...approvedCompositions],
			approvals: parts.map((part) => ({
				ref: part.ref,
				group: part.compositionGroup,
				bundleDigest: part.artifact.bundleDigest,
				instructions: part.template.generator!.instructions,
			})),
			scope:
				"Pre-approved parts imported from archived review and checked against delivered bytes. Public seed source validation, real cloud selection, new SQLite binding. No live host routing or real task execution.",
		};
		save("manifest.json", manifest);
		const receipts = new Map<string, string>();
		let attempt = "";
		const inference = (
			stage: string,
			selectedModel: CloudModel,
		): Ports<Database>["inference"] => ({
			validReceipt: (_tx, receipt, requestRef) =>
				receipts.get(receipt) === requestRef,
			async complete(input, signal) {
				const answer = await budget.complete(
					selectedModel,
					suite.id + ":" + attempt + ":" + stage,
					input,
					signal,
				);
				receipts.set(answer.receipt, input.requestRef);
				return answer;
			},
		});
		const service = createSkillSmith({
			...host.ports,
			now: Date.now,
			approvedSkills: store,
			selectionInference: inference("selection", model),
			compositionReviewInference: inference("review", reviewer),
			approvedDeliveryCompatibility: parts.map((p) => ({
				instructions: p.template.generator!.instructions,
				rendererVersion: p.artifact.rendererVersion,
				sourceExtractorVersion: p.artifact.sourceExtractorVersion,
			})),
		});
		const results: unknown[] = [],
			skills: Record<string, unknown> = {};
		const tasks = [...suite.tasks, suite.negative, ...additionalNegatives];
		for (let run = 1; run <= manifest.repeats; run++)
			for (const task of tasks) {
				attempt = task.id + ":" + run;
				const request: GuidanceRequest = {
					...host.request,
					requestId: attempt,
					delivery: "artifact",
					...requestFor(task),
					limits: {
						...host.request.limits,
						candidates: 8,
						deadlineAt: Date.now() + 120000,
						modelCalls: 2,
					},
				};
				const auth = host.authority;
				const context = {
					signal: AbortSignal.timeout(120000),
					reserve: async () => {},
				};
				const start = performance.now();
				const stages: Record<string, number> = {};
				let kind: string = "error",
					code: string | undefined,
					choice: unknown,
					compositionRefs: string[] | undefined;
				try {
					const prepared = service.prepareSkillSelection(db, request, auth);
					stages.catalog = performance.now() - start;
					const selected = await service.selectSkill(prepared, context);
					choice = selected.decision;
					stages.selection = performance.now() - start - stages.catalog;
					kind = selected.decision.kind;
					if (kind !== "miss") {
						const binding = db.transaction(() =>
							service.bindSkillSelection(db, prepared, selected, auth),
						)();
						const reply = await service.getSkillDelivery(
							binding.requestRef!,
							auth,
							(op) => op(db),
							context.signal,
							context,
						);
						kind = reply.kind;
						if (reply.kind === "ready") {
							skills[attempt] = reply.skill;
							compositionRefs = reply.compositionRefs;
						} else if ("code" in reply) code = reply.code;
					}
				} catch (error) {
					code = error instanceof Error ? error.message : "unknown";
					kind = code === "composition_not_approved" ? "rejected" : "error";
				}
				const durationMs = performance.now() - start;
				results.push({
					taskId: task.id,
					attempt,
					kind,
					durationMs,
					code,
					choice,
					compositionRefs,
					stages,
				});
				save("results.json", results);
				save("skills.json", skills);
				save("budget.json", {
					accountedUsd: budget.spent(),
					newEvents: budget
						.events()
						.filter((entry) => !startingIds.has(entry.id)),
				});
				console.log(
					JSON.stringify({ attempt, kind, durationMs, code, compositionRefs }),
				);
			}
	} finally {
		db.close();
		host.close();
		fixture.close();
	}
} finally {
	closeSync(lock);
	unlinkSync(journal + ".lock");
}
