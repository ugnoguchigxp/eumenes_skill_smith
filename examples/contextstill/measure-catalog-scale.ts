import { addCatalogLoad } from "./catalog-load.js";
/** Opt-in paid integration lane. Never runs from fixed tests; all calls share the cumulative cap. */
import {
	readFileSync,
	writeFileSync,
	mkdirSync,
	openSync,
	closeSync,
	rmSync,
	mkdtempSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createSkillSmith, digest, type Ports } from "../../src/index.js";
import { sqliteRepository } from "../../src/sqlite/index.js";
import { replayLibrary } from "./replay-library.js";
import { createCloudBudget } from "./cloud-budget.js";
import { savedCloud } from "./saved-cloud.js";
const root = resolve(import.meta.dir, "../.."),
	out = resolve(process.argv[2] ?? "artifacts/catalog-scale-v1");
const json = (path: string) =>
	JSON.parse(readFileSync(join(root, path), "utf8"));
const protocol = json(
	process.argv[3] ??
		"docs/quality/catalog-improvement-2026-11-09/scale-protocol.json",
);
const suite = json("docs/quality/low-latency-2026-11-08/selection-suite.json"),
	config = json("docs/quality/cloud-eval-generation-settings.json");
const model = [config.executor, config.judge].find(
	(m) => m.id === protocol.model,
);
if (!model) throw Error("unapproved_selection_model");
const journal = join(root, "artifacts/practical-2026-11-08/costs.jsonl");
const lock = openSync(journal + ".lock", "wx", 0o600);
const temp = mkdtempSync(join(tmpdir(), "smith-approved-measure-"));
mkdirSync(out, { recursive: true });
const manifest = openSync(join(out, "manifest.json"), "wx", 0o600);
writeFileSync(
	manifest,
	JSON.stringify({
		suiteDigest: digest(suite),
		protocolDigest: digest(protocol),
		model: model.id,
		startedAt: new Date().toISOString(),
		retries: 0,
	}),
);
closeSync(manifest);
const rows: unknown[] = [],
	records: unknown[] = [];
const save = (name: string, value: unknown) =>
	writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n", {
		mode: 0o600,
	});
try {
	const saved = await savedCloud(
		resolve(root, "../eumenes"),
		config.connectionId,
	);
	if (config.maxUsd !== 15 || !saved.models.includes(model.id))
		throw Error("model_or_budget_contract_changed");
	const budget = createCloudBudget({ ...saved, maxUsd: 15, journal });
	const spentBefore = budget.spent();
	const library = await replayLibrary(root, temp);
	try {
		save("delivery-regression.json", {
			results: library.deliveries,
			matchedReplayCalls: library.matchedReplayCalls,
			networkGenerationCalls: 0,
		});
		const receipts = new Set<string>();
		let active = "";
		const inference: Ports<unknown>["inference"] = {
			validReceipt: (_tx, r) => receipts.has(r),
			complete: async (input, signal) => {
				const output = await budget.complete(
					model,
					"catalog-scale:" + active,
					input,
					signal,
				);
				receipts.add(output.receipt);
				records.push({ attempt: active, input, ...output });
				save("records.json", records);
				return output;
			},
		};
		const service = createSkillSmith({ ...library.ports, inference });
		const base = sqliteRepository.request(
			library.db,
			library.ports.repository.build(
				library.db,
				library.ports.approvedSkills!.list(library.db, "example", 20)[0]!
					.template.ref,
			)!.requestRef,
		)!;

		const store = library.ports.approvedSkills!;
		const original = store.list(library.db, "example", 20)[0]!;
		const syntheticApprovals = new Set<string>(),
			wasCurrent = store.approvalCurrent;
		store.approvalCurrent = (tx, r) =>
			wasCurrent(tx, r) || syntheticApprovals.has(r.digest);
		let inserted = 0;
		const construction: unknown[] = [];
		for (const level of protocol.levels as number[]) {
			const preparation = addCatalogLoad(
				library.db,
				store,
				original,
				inserted,
				level - 3,
				syntheticApprovals,
			);
			inserted = level - 3;
			construction.push({ level, ...preparation });
			save("construction.json", construction);
			for (
				let repetition = 0;
				repetition < protocol.repetitionsPerCasePerLevel;
				repetition++
			)
				for (const task of [
					...suite.cases,
					...(protocol.additionalCases ?? []),
				]) {
					active = `${level}:${task.id}:${repetition}`;
					const started = performance.now(),
						abort = AbortSignal.timeout(protocol.attemptTimeoutMs),
						calls: unknown[] = [];
					const request = {
						...structuredClone(base.request),
						requestId: "select:" + active,
						task: { ...structuredClone(base.request.task), goal: task.goal },
						limits: { ...base.request.limits, outputTokens: 256 },
					};
					let reservedModels = 0,
						reply: unknown = null,
						correct = false,
						actualRef: string | null = null;
					try {
						const prepared = service.prepareSkillSelection(
							library.db,
							request,
							base.authority,
						);
						const selection = await service.selectSkill(prepared, {
							signal: abort,
							reserve: async (kind) => {
								if (kind !== "modelCalls" || ++reservedModels > 1)
									throw Error("selection_budget_exceeded");
							},
							noteCall: (c) => calls.push(c),
						});
						if (selection.decision.kind === "selected") {
							actualRef = selection.decision.ref;
							const bound = library.db.transaction(() =>
								service.bindSkillSelection(
									library.db,
									prepared,
									selection,
									base.authority,
								),
							)();
							reply = await service.getSkillDelivery(
								bound.requestRef!,
								base.authority,
								(op) => op(library.db),
								abort,
								{
									signal: abort,
									reserve: async (kind) => {
										library.db.transaction(() =>
											service.reserveDelivery(
												library.db,
												bound.requestRef!,
												base.authority,
												kind,
											),
										)();
									},
									noteCall: (c) => calls.push(c),
								},
							);
						} else {
							// A miss is handed to the existing generation queue, never counted as usable-ready.
							reply = library.db.transaction(() =>
								service.submitAfterSkillMiss(
									library.db,
									prepared,
									selection,
									base.authority,
								),
							)();
						}
						const expectedRef =
							library.publications.find((p) => p.taskId === task.expected)
								?.ref ?? null;
						correct =
							actualRef === expectedRef &&
							(actualRef
								? (reply as { kind: string }).kind === "ready"
								: (reply as { kind: string }).kind === "pending");
					} catch (error) {
						reply = {
							kind: "error",
							code: error instanceof Error ? error.message : "unknown",
						};
					}
					const durationMs = performance.now() - started,
						kind = (reply as { kind: string }).kind;
					rows.push({
						attempt: active,
						level,
						expected: task.expected,
						actualRef,
						correct,
						durationMs,
						kind,
						usableWithinTarget:
							correct &&
							kind === "ready" &&
							durationMs <= protocol.readyTargetMs,
						calls,
						reply,
					});
					save("attempts.json", rows);
					save("budget.json", {
						spentBefore,
						accountedUsd: budget.spent(),
						incrementalUsd: budget.spent() - spentBefore,
						capUsd: 15,
					});
					console.log(
						JSON.stringify({
							attempt: active,
							kind,
							correct,
							durationMs: Math.round(durationMs),
						}),
					);
				}
		}

		save("complete.json", {
			complete: true,
			attempts: rows.length,
			accountedUsd: budget.spent(),
			incrementalUsd: budget.spent() - spentBefore,
			scope:
				"Actual cloud selection plus durable SQLite task binding, local public fixture version validation and full artifact retrieval. Fixed replay business clock. 9/1000/10000 registrations include explicitly synthetic load records. Not a production Eumenes/ContextStill network benchmark or cold generation.",
		});
	} finally {
		library.close();
	}
} finally {
	closeSync(lock);
	rmSync(journal + ".lock", { force: true });
	rmSync(temp, { recursive: true, force: true });
}
