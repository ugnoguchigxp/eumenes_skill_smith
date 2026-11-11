import { expect, test } from "bun:test";
import { createContextStillSource } from "../index.js";

test("MCP binds disclosed content and refuses stale, clipped or withdrawn evidence", async () => {
	const handle = "kn_" + "a".repeat(26);
	const trust = {
		trustClass: "untrusted_knowledge_evidence",
		instructionAuthority: "none",
	};
	const base = {
		handle,
		revision: 1,
		title: "A procedure",
		status: "active",
		space: "coding",
	};
	let body = "Read the documented version.";
	let clipped = false;
	let withdrawn = false;
	const calls: string[] = [];
	const source = createContextStillSource({
		endpoint: "http://127.0.0.1:39181/mcp",
		token: "fixture-token".padEnd(24, "x"),
		fetch: (async (_url, init) => {
			const request = JSON.parse(String(init?.body));
			calls.push(request.method);
			if (request.method === "notifications/initialized")
				return new Response(null, { status: 202 });
			let result;
			if (request.method === "initialize") {
				result = {
					protocolVersion: "2025-03-26",
					serverInfo: { name: "context-still" },
					capabilities: { tools: {} },
				};
			} else if (request.method === "tools/list") {
				result = {
					tools: [{ name: "search_knowledge" }, { name: "get_knowledge" }],
				};
			} else {
				const searching = request.params.name === "search_knowledge";
				const payload = searching
					? {
							contractVersion: "contextstill-search.v1",
							trust,
							results: [base],
							warnings: [],
							degraded: [],
							truncated: false,
						}
					: withdrawn
						? { error: "not_found" }
						: {
								contractVersion: "contextstill-knowledge.v1",
								trust,
								item: {
									...base,
									body,
									contentTruncated: clipped,
									evidenceTruncated: false,
								},
							};
				result = {
					content: [{ type: "text", text: JSON.stringify(payload) }],
					isError: !searching && withdrawn,
				};
			}
			return Response.json({ jsonrpc: "2.0", id: request.id, result });
		}) as typeof fetch,
	});
	const signal = new AbortController().signal;
	let reserved = 0;
	const context = {
		signal,
		reserve: async () => {
			reserved++;
		},
	};
	const search = await source.search("public query", 2, signal, context);
	expect(reserved).toBe(4);
	const card = search.cards[0]!;
	expect(card).toMatchObject({ revisionOnly: true, complete: false });
	const first = await source.get(card.ref, signal, context);
	expect(first.version.version).toBe(card.version.version);
	expect(first.complete).toBe(true);
	expect(await source.validate([first], signal, context)).toBe(true);
	body += " New evidence.";
	expect(await source.validate([first], signal, context)).toBe(false);
	body = "Read the documented version.";
	clipped = true;
	expect(await source.validate([first], signal, context)).toBe(false);
	withdrawn = true;
	expect(await source.validate([first], signal, context)).toBe(false);
	expect(reserved).toBe(calls.length);
});
