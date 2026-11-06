import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ContextStillFixture } from "../database.js";
import { MAX_BYTES, searchArgs } from "../contracts.js";
import { handle, item, setup } from "./fixture.js";

test("snapshot is required and raw production-style databases are rejected", () => {
	const f = setup();
	const raw = new Database(`${f.dir}/raw.sqlite`);
	raw.exec("CREATE TABLE settings_credentials(secret TEXT)");
	raw.close();
	expect(() => new ContextStillFixture(`${f.dir}/missing.sqlite`)).toThrow();
	expect(() => new ContextStillFixture(`${f.dir}/raw.sqlite`)).toThrow(
		"fixture_snapshot_required",
	);
});
test("MCP initializes, lists both native tools and accepts initialized notification", async () => {
	const f = setup();
	expect((await f.rpc("initialize")).error).toBeUndefined();
	const list = (await (
		await f.handler(f.request({ jsonrpc: "2.0", id: 1, method: "tools/list" }))
	).json()) as { result: { tools: { name: string }[] } };
	expect(list.result.tools.map((t) => t.name)).toEqual([
		"search_knowledge",
		"get_knowledge",
	]);
	expect(
		(
			await f.handler(
				f.request({ jsonrpc: "2.0", method: "notifications/initialized" }),
			)
		).status,
	).toBe(202);
});
test("auth, Host, Origin, path, method and content type are enforced", async () => {
	const f = setup(),
		body = { jsonrpc: "2.0", id: 1, method: "ping" };
	for (const [headers, status] of [
		[{ authorization: "Bearer invalid" }, 401],
		[{ host: "evil.example" }, 403],
		[{ origin: "https://evil.example" }, 403],
		[{ "content-type": "text/plain" }, 415],
	] as const)
		expect((await f.handler(f.request(body, headers))).status).toBe(status);
	expect((await f.handler(new Request("http://127.0.0.1/other"))).status).toBe(
		404,
	);
	expect((await f.handler(new Request("http://127.0.0.1/mcp"))).status).toBe(
		405,
	);
});
test("oversized bodies are rejected with and without Content-Length", async () => {
	const f = setup();
	for (const headers of [
		{},
		{ "content-length": String(MAX_BYTES + 1) },
	] as Record<string, string>[])
		expect(
			(await f.handler(f.request({ text: "a".repeat(MAX_BYTES) }, headers)))
				.status,
		).toBe(413);
});
test("invalid JSON, JSON-RPC, unknown methods/tools and invalid strict arguments fail", async () => {
	const f = setup();
	const malformed = new Request(f.request({}), { method: "POST", body: "{" });
	expect((await f.handler(malformed)).status).toBe(400);
	expect((await f.rpc("nonexistent")).error?.code).toBe(-32601);
	expect(
		(await f.rpc("tools/call", { name: "write", arguments: {} })).error?.code,
	).toBe(-32602);
	for (const args of [
		{ query: "検証", repoPath: "/secret" },
		{ query: "検証", spaces: ["personal"] },
		{ query: "検証", kinds: ["knowledge", "knowledge"] },
		{ query: "検証", limit: 21 },
		{ query: "" },
	])
		expect((await f.call("search_knowledge", args)).payload).toEqual({
			error: "invalid_arguments",
		});
	expect(
		(await f.call("get_knowledge", { handle: "kn_invalid" })).isError,
	).toBe(true);
	expect(
		(await f.call("get_knowledge", { handle: handle("z") })).payload,
	).toEqual({ error: "not_found" });
});
test("public filters precede limits, including a corrupt snapshot with private/retracted rows", () => {
	const f = setup();
	f.writer.exec("PRAGMA ignore_check_constraints=ON");
	for (const [char, attrs] of [
		["c", { scope: "repo" }],
		["d", { space: "personal" }],
		["e", { status: "retracted" }],
		["f", { retrieval: "evidence_only" }],
	] as const) {
		f.put(item({ handle: handle(char) }), attrs);
		expect(f.fixture.get(handle(char))).toBeNull();
	}
	const hits = f.fixture.search(
		searchArgs.parse({
			query: "検証",
			kinds: ["knowledge", "episode"],
			limit: 20,
		}),
	);
	expect(hits.results.map((r) => r.handle).sort()).toEqual(
		[handle("b", "ep"), handle("a")].sort(),
	);
});
test("superseded and candidate items can be read but are not searched", () => {
	const f = setup();
	for (const [char, status] of [
		["c", "superseded"],
		["d", "candidate"],
	] as const)
		f.put(
			item({ handle: handle(char), status }),
			status === "superseded" ? { retrieval: "evidence_only" } : {},
		);
	expect(f.fixture.get(handle("c"))?.item.status).toBe("superseded");
	expect(f.fixture.get(handle("d"))?.item.status).toBe("candidate");
	expect(
		f.fixture
			.search(searchArgs.parse({ query: "検証" }))
			.results.map((r) => r.handle),
	).toEqual([handle("a")]);
});
test("lexical search accepts Japanese and safely treats SQL/FTS syntax as data", () => {
	const f = setup();
	for (const query of [
		"検証",
		'検証 " OR 1=1 --',
		"検証 ) OR *",
		"検証'; DROP TABLE items;--",
	]) {
		const result = f.fixture.search(searchArgs.parse({ query }));
		expect(result.results.map((r) => r.handle)).toEqual([handle("a")]);
		expect(result.degraded).toContain("mock_lexical_only");
	}
	expect(f.fixture.search(searchArgs.parse({ query: "x" })).results).toEqual(
		[],
	);
	expect(
		f.fixture.search(searchArgs.parse({ query: "zz_nonexistent_zz" })).results,
	).toEqual([]);
});
test("conflict warnings name returned pairs; unsupported theme/depth is explicit", () => {
	const f = setup([item(), item({ handle: handle("b") })]);
	f.writer
		.query("INSERT INTO conflicts VALUES(?,?)")
		.run(handle("a"), handle("b"));
	const args = searchArgs.parse({ query: "検証", theme: "unknown", depth: 1 });
	expect(f.fixture.search(args).warnings).toEqual([
		{ kind: "unresolved_conflict", handles: [handle("a"), handle("b")] },
	]);
	expect(f.fixture.search({ ...args, limit: 1 }).warnings).toEqual([]);
	expect(f.fixture.search(args).degraded).toContain("theme_unavailable");
	expect(f.fixture.search(args).degraded).toContain("expansion_unavailable");
});
test("byte and Unicode bounds mark incomplete content without silently claiming completeness", async () => {
	const f = setup([item({ body: '😀"\\'.repeat(9000) })]);
	const response = await f.handler(
		f.request({
			jsonrpc: "2.0",
			id: "x".repeat(128),
			method: "tools/call",
			params: { name: "get_knowledge", arguments: { handle: handle("a") } },
		}),
	);
	const bytes = new Uint8Array(await response.arrayBuffer());
	expect(bytes.byteLength).toBeLessThanOrEqual(MAX_BYTES);
	const doc = f.fixture.get(handle("a"))!;
	expect(doc._fixture.complete).toBe(false);
	expect(JSON.stringify(doc.item)).not.toContain("\\ud83d");
	expect(
		f.fixture.search(searchArgs.parse({ query: "検証" })).results[0]?._fixture,
	).toEqual(doc._fixture);
});
