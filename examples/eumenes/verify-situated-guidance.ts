/** Exercise both Eumenes specialist turns with a scripted specialist and a metered cloud selector. */
import {
	closeSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createCloudBudget,
	type CloudModel,
} from "../contextstill/cloud-budget.js";
import { digest } from "../../src/index.js";
import { savedCloud } from "../contextstill/saved-cloud.js";

function check(condition: unknown, code: string): asserts condition {
	if (!condition) throw Error(code);
}
function arg(flag: string) {
	const index = process.argv.indexOf(flag);
	check(index >= 0 && process.argv[index + 1], "missing_" + flag);
	return resolve(process.argv[index + 1]!);
}
const root = arg("--host");
const out = arg("--out");
const live = process.argv.includes("--live");
const load = (path: string) => import(pathToFileURL(join(root, path)).href);
const [{ harness }, { searchThenDelegate }, { createGitObservation }] =
	await Promise.all([
		load("api/application/toolchain/toolchain.fixture.ts"),
		load("api/application/toolchain/conversation-script.fixture.ts"),
		load("api/domains/git-observation/index.ts"),
	]);
const cases = [
	{
		toolchain: "app.develop",
		functionName: "develop_app",
		version: 8,
		goal: "予約アプリで、週の切り替え直後に表示される空の予約一覧を調べたい。",
		acceptance: "原因を切り分ける最初の観察手順を示せる。",
		action: "週表示を切り替え、一覧を開き直した。",
		result: "見出しの日付は変わるが、予約一覧は空のままだった。",
		ready:
			"隔離したデモの設定と表示は読み取りできる。週の範囲と一覧の絞り込みのどちらを先に確認するか迷っている。",
		miss: "本番画面しかなく、観察には実顧客の予約を開く必要がある。そのアクセスの許可も匿名化済みの資料もなく、許可済みの観察先が分からない。",
	},
	{
		toolchain: "markdown.collaborate",
		functionName: "markdown_edit",
		version: 5,
		goal: "運用引き継ぎ文書の脚注がプレビューに出ない理由を調べたい。",
		acceptance: "原因を切り分ける最初の観察手順を示せる。",
		action: "既存の脚注参照を同じ段落に書き直してプレビューを見た。",
		result: "参照番号は表示されたが、注記本文が末尾に出なかった。",
		ready:
			"個人情報のない作業コピーと設定を読み取れる。脚注定義の位置と表示機能の設定のどちらを先に確認するか迷っている。",
		miss: "脚注はアクセス未承認の機密文書への外部参照で、実体を開かずに観察できるコピー、設定、手順書がない。許可が取れるまで何も観察できない。",
	},
] as const;
const expected = readFileSync(
	join(
		import.meta.dir,
		"../../docs/quality/exploration-ja-2026-11-11/safe-task-exploration-ja/SKILL.md",
	),
	"utf8",
);
const archive = {
	available: () => true,
	binding: () => "situated-guidance-fixture",
	list: async () => ({ items: [], namespaces: ["eumenes"], nextCursor: null }),
};
let budget: ReturnType<typeof createCloudBudget> | undefined;
let model: CloudModel | undefined;
let journal: string | undefined;
let lock: number | undefined;
let startUsd: number | undefined;
const rows: unknown[] = [];
try {
	if (live) {
		const settings = JSON.parse(readFileSync(arg("--settings"), "utf8"));
		check(settings.maxUsd === 20, "unexpected_budget");
		journal = arg("--journal");
		lock = openSync(journal + ".lock", "wx", 0o600);
		const saved = await savedCloud(
			arg("--settings-host"),
			settings.connectionId,
		);
		model = settings.judge as CloudModel;
		check(saved.models.includes(model.id), "model_not_in_catalog");
		budget = createCloudBudget({ ...saved, maxUsd: settings.maxUsd, journal });
		startUsd = budget.spent();
		check(startUsd >= 18.5365665, "cumulative_journal_required");
	}
	for (const item of cases) {
		const resourceId = crypto.randomUUID();
		let mode: "ready" | "miss" | "stale" = "ready";
		let sentSituation: Record<string, unknown> | undefined;
		let report = "";
		let providerCalls = 0;
		let started = 0;
		let durationMs = 0;
		let result: any;
		const measurement: { inputTokens?: number; outputTokens?: number } = {};
		const host = await harness({
			markdown: archive,
			...(item.toolchain === "app.develop"
				? { appDevelopment: { git: createGitObservation("/unused") } }
				: {}),
			routeTool: item.functionName,
			firstRound: (_tools: unknown, _question: unknown, messages: unknown) =>
				searchThenDelegate(
					(candidate: { id: string }) => candidate.id === item.toolchain,
					item.goal,
					{ announcement: "制作担当に引き継ぎます。", impact: "create" },
				)(messages),
			knowledgeSelectionResourceId: resourceId,
			inferenceOptions: {
				fetch: async (_url: unknown, init: RequestInit) => {
					providerCalls++;
					const request = JSON.parse(String(init.body));
					const messages = request.messages as {
						role: string;
						content: string;
					}[];
					const system = messages
						.filter(({ role }) => role === "system" || role === "developer")
						.map(({ content }) => content)
						.join("\n");
					check(system.includes("fixed exploration SKILL"), "wrong_selector");
					const data = JSON.parse(
						messages.find(({ role }) => role === "user")!.content,
					);
					check(data.task.goal === item.goal, "goal_changed");
					check(
						digest(data.task.situation) ===
							digest({ ...sentSituation, report }),
						"situation_not_forwarded",
					);
					check(!("publicSearchTask" in data), "unexpected_public_search");
					let value: unknown =
						mode === "ready"
							? {
									kind: "explore",
									language: "en",
									assessment: "Safe read-only observation is available.",
								}
							: { kind: "miss", reason: "No authorized observation target." };
					if (budget && model) {
						const purpose = `situated-guidance:${item.toolchain}:${mode}`;
						const answer = await budget.complete(
							model,
							purpose,
							{
								system,
								data,
								schema:
									request.response_format.json_schema.schema.properties.result,
								requestRef: purpose,
								maxOutputTokens: 128,
								deadlineAt: Date.now() + 15_000,
							},
							init.signal ?? AbortSignal.timeout(15_000),
						);
						value = answer.value;
						measurement.inputTokens = answer.inputTokens;
						measurement.outputTokens = answer.outputTokens;
					}
					return Response.json({
						choices: [
							{ message: { content: JSON.stringify({ result: value }) } },
						],
						usage: {
							prompt_tokens: measurement.inputTokens ?? 70,
							completion_tokens: measurement.outputTokens ?? 20,
						},
					});
				},
			},
			specialist: (messages: { role: string; content: string }[]) => {
				const toolResult = messages.at(-1)?.content;
				if (toolResult?.startsWith("TOOL_RESULT=")) {
					durationMs = performance.now() - started;
					result = JSON.parse(toolResult.slice("TOOL_RESULT=".length));
					return { action: "reply", text: "SKILLの参照結果を確認しました。" };
				}
				const candidate = messages.find(({ content }) =>
					content.startsWith("GUIDANCE_CANDIDATES="),
				);
				check(
					candidate &&
						JSON.parse(candidate.content.slice("GUIDANCE_CANDIDATES=".length))
							.candidates[0]?.content === expected,
					"initial_japanese_candidate_missing",
				);
				check(
					messages.at(-1)?.content.includes(report),
					"original_report_missing",
				);
				check(
					messages[0]?.content.includes("get_guidance"),
					"tool_not_registered",
				);
				const revision = /CURRENT_DOCUMENT[^\n]* revision=(\d+)/.exec(
					messages[1]?.content ?? "",
				)?.[1];
				check(revision !== undefined, "working_revision_missing");
				sentSituation = {
					revision: mode === "stale" ? String(Number(revision) + 1) : revision,
					lastAttempt: { action: item.action, result: item.result },
					uncertainty: mode === "miss" ? item.miss : item.ready,
				};
				started = performance.now();
				return {
					action: "invoke",
					tool: "get_guidance",
					arguments: {
						goal: item.goal,
						acceptance: [{ id: "explore", text: item.acceptance }],
						situation: sentSituation,
						skillLanguage: "ja",
					},
				};
			},
		});
		try {
			const settings = host.settings.get();
			const connectionId = crypto.randomUUID();
			settings.connections.push({
				id: connectionId,
				name: "Metered selector",
				baseUrl: "http://127.0.0.1:19999/v1",
				enabled: true,
				epoch: 0,
				envRef: null,
			});
			settings.resources.push({
				id: resourceId,
				connectionId,
				purpose: "llm",
				model: model?.id ?? "fixture",
				contextWindow: 32768,
				voice: null,
			});
			Object.assign(settings.routes.llm, {
				mode: "larm-preferred",
				cloudAllowed: true,
				fallbackId: resourceId,
			});
			await host.settings.apply({
				requestId: crypto.randomUUID(),
				expectedRevision: settings.revision,
				settings,
				keys: [{ connectionId, value: "fixture-key" }],
			});
			for (const scenario of ["ready", "miss", "stale"] as const) {
				mode = scenario;
				result = undefined;
				delete measurement.inputTokens;
				delete measurement.outputTokens;
				const before = providerCalls;
				report = mode === "miss" ? item.miss : item.goal + " " + item.ready;
				const response = await host.request("/api/runs", {
					requestId: crypto.randomUUID(),
					conversationId: "main",
					text: report,
					guidanceLanguage: "ja",
				});
				check(response.status === 202, "turn_not_accepted");
				const run = await response.json();
				const done = await host.dialogue.waitForTerminal(run.id, {
					timeoutMs: 20_000,
				});
				check(
					done?.status === "completed",
					`turn_not_completed:${item.toolchain}:${mode}:${JSON.stringify(done)}`,
				);
				const session = (
					await (
						await host.request("/api/conversations/main/specialist")
					).json()
				).session;
				check(
					session?.toolchainRevisionId ===
						`toolchain:${item.toolchain}@${item.version}`,
					"wrong_binding_revision",
				);
				check(
					providerCalls - before === (mode === "stale" ? 0 : 1),
					`unexpected_model_calls:${item.toolchain}:${mode}:${JSON.stringify(result)}`,
				);
				check(
					mode === "stale"
						? result?.error === "guidance_revision_mismatch"
						: result?.ok === true,
					`tool_call_failed:${JSON.stringify(result)}`,
				);
				const value = result?.result;
				check(
					mode !== "ready" ||
						(value?.kind === "ready" &&
							value.exploration &&
							value.skill.content === expected &&
							digest(value.situation) === digest({ ...sentSituation, report })),
					"wrong_skill",
				);
				check(
					mode !== "miss" || value?.kind === "unavailable",
					"unsafe_skill_selected",
				);
				rows.push({
					toolchain: item.toolchain,
					scenario,
					durationMs,
					kind: value?.kind ?? result.error,
					...measurement,
				});
			}
		} finally {
			await host.close();
		}
	}
} finally {
	if (lock !== undefined && journal) {
		closeSync(lock);
		unlinkSync(journal + ".lock");
	}
}
const result = {
	model: model?.id ?? "fixture",
	costUsd:
		budget && startUsd !== undefined ? budget.spent() - startUsd : undefined,
	rows,
};
writeFileSync(out, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(result, null, 2));
