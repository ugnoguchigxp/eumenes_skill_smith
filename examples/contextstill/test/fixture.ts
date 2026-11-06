import { Database } from "bun:sqlite";
import { afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORMAT } from "../contracts.js";
import type { PublicItem } from "../contracts.js";
import { ContextStillFixture } from "../database.js";
import { createMcpHandler } from "../mcp.js";
import { createFixtureSource } from "../source.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanup.splice(0).reverse()) fn();
});
export const handle = (char: string, prefix = "kn") =>
	`${prefix}_${char.repeat(26)}`;
export function item(
	over: Partial<Extract<PublicItem, { kind: "knowledge" }>> = {},
): PublicItem {
	return {
		handle: handle("a"),
		kind: "knowledge",
		layer: "canonical",
		type: "procedure",
		polarity: "positive",
		title: "検証の手順",
		situation: "出所を確認する場面",
		body: "原資料を比較して検証する。",
		rationale: "差異の根拠を残すため。",
		exceptions: ["原資料が存在しない場合は保留"],
		appliesWhen: ["比較できる原資料がある"],
		notAppliesWhen: ["出所が不明"],
		steps: ["原資料を取得する", "差異を照合する"],
		examples: [],
		confidence: 0.9,
		importance: 0.5,
		status: "active",
		space: "general",
		createdAt: "2026-11-01",
		updatedAt: "2026-11-01",
		supportCount: 1,
		supersededBy: null,
		evidence: [{ role: "supports", sourceKind: "document" }],
		evidenceTruncated: false,
		...over,
	};
}
export function episode(): PublicItem {
	return {
		handle: handle("b", "ep"),
		kind: "episode",
		title: "検証の経験",
		situation: "差異が見つかった",
		intent: "原因を調べる",
		decision: "正本を確認する",
		observations: "版が異なる",
		action: "版を比較",
		outcome: "原因を確認",
		lesson: "取得版を記録する",
		openQuestions: [],
		outcomeKind: "success",
		eventStart: null,
		eventEnd: null,
		timePrecision: "unknown",
		confidence: 0.8,
		importance: 0.5,
		status: "active",
		space: "coding",
		createdAt: "2026-11-01",
		updatedAt: "2026-11-01",
		evidence: [],
		evidenceTruncated: false,
	};
}
export function setup(documents: PublicItem[] = [item(), episode()]) {
	const dir = mkdtempSync(join(tmpdir(), "skillsmith-contextstill-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "snapshot.sqlite");
	const writer = new Database(path);
	cleanup.push(() => writer.close());
	writer.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
	writer
		.query("INSERT INTO fixture_metadata VALUES('format',?)")
		.run(JSON.stringify(FORMAT));
	writer
		.query("INSERT INTO fixture_metadata VALUES('snapshotAt',?)")
		.run(JSON.stringify("2026-11-01T00:00:00Z"));
	function put(
		document: PublicItem,
		override: {
			scope?: string;
			space?: string;
			status?: string;
			retrieval?: string;
			revision?: number;
		} = {},
	) {
		writer
			.query("INSERT OR REPLACE INTO items VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
			.run(
				document.handle,
				document.kind,
				document.kind === "knowledge" ? document.type : null,
				override.space ?? document.space,
				override.scope ?? "global",
				override.status ?? document.status,
				override.retrieval ?? "searchable",
				document.kind === "knowledge" ? document.layer : null,
				override.revision ?? 1,
				document.title,
				JSON.stringify(document),
				JSON.stringify(document),
			);
		writer.exec("INSERT INTO items_fts(items_fts) VALUES('rebuild')");
	}
	for (const doc of documents) put(doc);
	const fixture = new ContextStillFixture(path);
	cleanup.push(() => fixture.close());
	const token = "fixture-only-test-token-123456";
	const handler = createMcpHandler(fixture, token);
	const source = createFixtureSource(handler, token);
	const request = (body: unknown, headers: Record<string, string> = {}) =>
		new Request("http://127.0.0.1/mcp", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				...headers,
			},
			body: JSON.stringify(body),
		});
	async function rpc(method: string, params?: unknown) {
		const response = await handler(
			request({ jsonrpc: "2.0", id: "test", method, params }),
		);
		return response.json() as Promise<{
			result: { content: { text: string }[]; isError?: boolean };
			error?: { code: number };
		}>;
	}
	async function call(name: string, args: unknown) {
		const response = await rpc("tools/call", { name, arguments: args });
		return {
			isError: response.result.isError ?? false,
			payload: JSON.parse(response.result.content[0]!.text) as Record<
				string,
				unknown
			>,
		};
	}
	return {
		dir,
		path,
		writer,
		put,
		fixture,
		token,
		handler,
		source,
		request,
		rpc,
		call,
		signal: new AbortController().signal,
	};
}
