/** Verify the Eumenes HTTP entry with both real applications in process and isolated stores. */
import {
	closeSync,
	existsSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createCloudBudget,
	type CloudModel,
} from "../contextstill/cloud-budget.js";
import { savedCloud } from "../contextstill/saved-cloud.js";
import { skillDeliverySchema } from "../../src/index.js";

const args = process.argv.slice(2);
function arg(flag: string) {
	const value = args[args.indexOf(flag) + 1];
	if (!args.includes(flag) || !value) throw Error("missing_" + flag);
	return resolve(value);
}
function check(condition: unknown, code: string): asserts condition {
	if (!condition) throw Error(code);
}
const live = args.includes("--live");
const root = arg("--host");
const contextRoot = arg("--context");
const output = arg("--out");
const suite = JSON.parse(readFileSync(arg("--suite"), "utf8")) as {
	id: string;
	goal: string;
	acceptance: string;
}[];
check(!existsSync(output), "fresh_output_required");
const load = (workspace: string, path: string) =>
	import(pathToFileURL(join(workspace, path)).href);
const [
	hostStore,
	hostSettings,
	hostInference,
	hostQueue,
	hostKnowledge,
	hostRoutes,
	hostApp,
	hostMigrations,
	contextStore,
	contextMigrations,
	contextMcp,
	contextSearch,
	contextItems,
	contextHono,
	sdk,
] = await Promise.all([
	load(root, "api/infrastructure/sqlite/index.ts"),
	load(root, "api/domains/settings/index.ts"),
	load(root, "api/domains/inference/index.ts"),
	load(root, "api/domains/queue/index.ts"),
	load(root, "api/application/knowledge/service.ts"),
	load(root, "api/application/knowledge/routes.ts"),
	load(root, "api/application/app.ts"),
	load(root, "api/application/migrations.ts"),
	load(contextRoot, "api/infrastructure/sqlite/test-support.ts"),
	load(contextRoot, "api/application/migrations.ts"),
	load(contextRoot, "api/domains/mcp/index.ts"),
	load(contextRoot, "api/domains/search/index.ts"),
	load(contextRoot, "api/domains/knowledge/index.ts"),
	load(contextRoot, "node_modules/hono/dist/index.js"),
	load(root, "node_modules/eumenes-skill-smith/dist/index.js"),
]);
const contextFixture = contextStore.tempStore(contextMigrations.allMigrations);
const directory = mkdtempSync(join(tmpdir(), "eumenes-contextstill-"));
const dbPath = join(directory, "eumenes.sqlite");
const host = hostStore.openStore(dbPath, hostMigrations.migrations);
const endpoint = "http://127.0.0.1:39181/mcp";
const mcpToken = "fixture-mcp".padEnd(32, "x");
const apiToken = "fixture-api".padEnd(32, "x");
const stamp = "2026-11-11T00:00:00.000Z";
let mcpCalls = 0;
let inference: { close(): Promise<void> } | undefined;
let queue: { close(): Promise<void> } | undefined;
let lock: number | undefined;
let journal: string | undefined;
let budget: ReturnType<typeof createCloudBudget> | undefined;
let startingUsd: number | undefined;
let startIds = new Set<string>();
let taskId = "";
let modelCalls = 0;
try {
	let model: CloudModel | undefined;
	if (live) {
		const settings = JSON.parse(readFileSync(arg("--settings"), "utf8")) as {
			connectionId: string;
			maxUsd: number;
			judge: CloudModel;
		};
		journal = arg("--journal");
		check(
			settings.maxUsd === 20 && existsSync(journal),
			"existing_cumulative_journal_required",
		);
		lock = openSync(journal + ".lock", "wx", 0o600);
		const saved = await savedCloud(
			arg("--settings-host"),
			settings.connectionId,
		);
		model = settings.judge;
		check(saved.models.includes(model.id), "model_not_in_catalog");
		budget = createCloudBudget({ ...saved, maxUsd: settings.maxUsd, journal });
		startingUsd = budget.spent();
		check(startingUsd >= 18.5254145, "journal_missing_previous_evaluation");
		startIds = new Set(budget.events().map((entry) => entry.id));
	}
	const ctxApp = new contextHono.Hono();
	contextMcp.registerMcp(ctxApp, {
		path: "/mcp",
		token: mcpToken,
		allowedHosts: [new URL(endpoint).host],
		store: contextFixture.store,
		search: contextSearch.createSearch({
			store: contextFixture.store,
			spaceKey: "fixture",
		}),
	});
	const ctxSource = sdk.createContextStillSource({
		endpoint,
		token: mcpToken,
		fetch: async (url: URL, init: RequestInit) => {
			mcpCalls++;
			const headers = new Headers(init.headers);
			headers.set("host", url.host);
			return ctxApp.request(String(url), { ...init, headers });
		},
	});
	const item = {
		id: "eumenes-contract-fixture",
		layer: "atom",
		type: "procedure",
		polarity: "positive",
		title: "Quince fixture",
		body: "Read the quince index before copying it.",
		appliesWhen: [],
		notAppliesWhen: [],
		steps: [],
		facets: {},
		confidence: 0.8,
		importance: 0.7,
		status: "active",
		space: "coding",
		scope: "global",
		repoKey: null,
		validFrom: null,
		validUntil: null,
		provenanceStatus: "resolved",
		metadata: {},
		createdAt: stamp,
		updatedAt: stamp,
	};
	const put = (body: string) =>
		contextFixture.store.write((tx: unknown) =>
			contextItems.upsertKnowledgeItem(tx, { ...item, body }),
		);
	await put(item.body);
	const settings = await hostSettings.createSettings(host, { dbPath, env: {} });
	const config = settings.get();
	const connectionId = crypto.randomUUID(),
		resourceId = crypto.randomUUID();
	config.connections.push({
		id: connectionId,
		name: "Isolated measurement",
		baseUrl: "http://127.0.0.1:19999/v1",
		enabled: true,
		epoch: 0,
		envRef: null,
	});
	config.resources.push({
		id: resourceId,
		connectionId,
		purpose: "llm",
		model: model?.id ?? "fixture",
		contextWindow: 32768,
		voice: null,
	});
	Object.assign(config.routes.llm, {
		mode: "cloud-only",
		cloudAllowed: true,
		fallbackId: resourceId,
	});
	await settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: config.revision,
		settings: config,
		keys: [{ connectionId, value: "fixture-key" }],
	});
	const engine = hostInference.createInference(host, settings, {
		fetch: async (_url: unknown, init: RequestInit) => {
			modelCalls++;
			const request = JSON.parse(String(init.body));
			const outputSchema =
				request.response_format?.json_schema?.schema?.properties?.result;
			check(outputSchema, "eumenes_strict_schema_missing");
			let value: unknown = {
				kind: "explore",
				language: "ja",
				assessment: "Read-only exploration is possible.",
			};
			let inputTokens = 70,
				outputTokens = 30;
			if (budget && model) {
				const messages = request.messages as {
					role: string;
					content: string;
				}[];
				const system = messages
					.filter((msg) => msg.role === "system" || msg.role === "developer")
					.map((msg) => msg.content)
					.join("\n");
				check(
					system.includes("fixed exploration SKILL"),
					"eumenes_selector_instructions_missing",
				);
				const prompt = messages.find((msg) => msg.role === "user");
				check(prompt, "eumenes_selector_input_missing");
				const data: unknown = JSON.parse(prompt.content);
				const signal = init.signal ?? AbortSignal.timeout(30000);
				const answer = await budget.complete(
					model,
					"eumenes-knowledge:" + taskId,
					{
						system,
						data,
						schema: outputSchema,
						requestRef: taskId,
						maxOutputTokens: Math.min(
							256,
							request.max_completion_tokens ?? request.max_tokens ?? 256,
						),
						deadlineAt: Date.now() + 30000,
					},
					signal,
				);
				value = answer.value;
				inputTokens = answer.inputTokens ?? 0;
				outputTokens = answer.outputTokens ?? 0;
			}
			return Response.json({
				choices: [{ message: { content: JSON.stringify({ result: value }) } }],
				usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
			});
		},
		larmFactory: () => ({
			status: () => ({ state: "unconfigured", capabilities: [] }),
			answer: async () => {
				throw Error("unexpected_local_model");
			},
			close: async () => {},
		}),
	});
	inference = engine;
	const jobs = hostQueue.createQueue(host);
	queue = jobs;
	const knowledge = hostKnowledge.createKnowledge({
		store: host,
		queue: jobs,
		control: engine,
		source: ctxSource,
	});
	const app = hostApp.createApp({
		token: apiToken,
		origin: "http://127.0.0.1:5173",
		modules: [
			{ mount: (app: unknown) => hostRoutes.registerKnowledge(app, knowledge) },
		],
	});
	const call = (path: string, body?: unknown, authorized = true) =>
		app.request(path, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				...(authorized ? { authorization: "Bearer " + apiToken } : {}),
				"content-type": "application/json",
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
	check(
		(await call("/api/knowledge/search", { query: "quince" }, false)).status ===
			401,
		"unauthenticated_search",
	);
	const search = await call("/api/knowledge/search", {
		query: "quince",
		limit: 4,
	});
	const cards = (await search.json()).cards;
	check(
		search.status === 200 && cards?.length === 1,
		"eumenes_mcp_search_failed",
	);
	const card = cards[0];
	const read = () =>
		call("/api/knowledge/sources/" + encodeURIComponent(card.ref));
	const first = await read();
	const original = await first.json();
	check(
		first.status === 200 &&
			original.complete &&
			original.version.version === card.version.version,
		"eumenes_mcp_read_failed",
	);
	await put("quince " + "a".repeat(7994));
	const clippedResponse = await read();
	const clipped = await clippedResponse.json();
	check(
		clippedResponse.status === 200 &&
			!clipped.complete &&
			clipped.version.version !== original.version.version,
		"eumenes_mcp_clipping_not_detected",
	);
	check(
		!(await ctxSource.validate([original], AbortSignal.timeout(1000))),
		"eumenes_mcp_stale_validation",
	);
	const priorCalls = mcpCalls;
	const expected = readFileSync(
		resolve(
			import.meta.dir,
			"../../docs/quality/exploration-ja-2026-11-11/safe-task-exploration-ja/SKILL.md",
		),
		"utf8",
	);
	const rows = [];
	for (const task of suite) {
		taskId = task.id;
		const request = {
			requestId: crypto.randomUUID(),
			goal: task.goal,
			acceptance: [{ id: "explore", text: task.acceptance }],
			publicSearchTask: "quince",
		};
		const started = performance.now();
		const response = await call("/api/knowledge/skills", request);
		const packet = skillDeliverySchema.safeParse(await response.json());
		const ms = performance.now() - started;
		const ready =
			packet.success && packet.data.kind === "ready" ? packet.data : null;
		const exact = !!(ready?.exploration && ready.skill.content === expected);
		rows.push({
			taskId: task.id,
			durationMs: ms,
			status: response.status,
			kind: packet.success ? packet.data.kind : "error",
			exactJapanese: exact,
		});
		if (ready) {
			const ref = "/api/knowledge/skills/" + ready.requestRef;
			const second = skillDeliverySchema.parse(await (await call(ref)).json());
			check(
				second.kind === "ready" &&
					second.skill.bundleDigest === ready.skill.bundleDigest,
				"eumenes_reread_mismatch",
			);
			const replay = skillDeliverySchema.parse(
				await (await call("/api/knowledge/skills", request)).json(),
			);
			check(
				replay.kind === "ready" && replay.requestRef === ready.requestRef,
				"eumenes_replay_mismatch",
			);
			check(
				(
					await call("/api/knowledge/skills", {
						...request,
						goal: request.goal + "変更",
					})
				).status === 409,
				"eumenes_replay_conflict",
			);
		}
	}
	const events = budget?.events().filter((entry) => !startIds.has(entry.id));
	const result = {
		scope:
			"Eumenes authenticated Hono HTTP, host inference and storage, ContextStill MCP in process",
		inference: live
			? "saved cloud model through metered evaluation transport"
			: "fixed provider responses",
		mcp: {
			calls: priorCalls,
			searchRevision: card.version.version,
			updatedRevision: clipped.version.version,
			clippedRejectedAsDependency: true,
			fastPathCalls: mcpCalls - priorCalls,
		},
		modelCalls,
		rows: rows.map((row) => {
			const event = events?.find(
				(entry) => entry.purpose === "eumenes-knowledge:" + row.taskId,
			);
			return {
				...row,
				...(event
					? {
							inputTokens: event.inputTokens,
							outputTokens: event.outputTokens,
							providerMs: event.durationMs,
						}
					: {}),
			};
		}),
		cost: budget
			? {
					startingUsd,
					accountedUsd: budget.spent(),
					addedUsd: budget.spent() - startingUsd!,
					capUsd: 20,
				}
			: undefined,
	};
	writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
	console.log(JSON.stringify(result));
	check(
		mcpCalls === priorCalls && modelCalls === suite.length,
		"eumenes_extra_call",
	);
	check(
		rows.every((row) => row.exactJapanese && row.durationMs <= 3000),
		"eumenes_delivery_target_missed",
	);
} finally {
	try {
		await queue?.close();
		await inference?.close();
		await host.close();
		await contextFixture.dispose();
		rmSync(directory, { recursive: true, force: true });
	} finally {
		if (lock !== undefined && journal) {
			closeSync(lock);
			unlinkSync(journal + ".lock");
		}
	}
}
