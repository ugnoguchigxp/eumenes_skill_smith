import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
	MAX_BYTES,
	byteLength,
	getArgs,
	searchArgs,
	toolEnvelope,
} from "./contracts.js";
import type { ContextStillFixture } from "./database.js";

export type LocalTransport = (request: Request) => Response | Promise<Response>;
const loopback = (host: string) =>
	["localhost", "127.0.0.1", "[::1]"].includes(host);
const rpcSchema = z.object({
	jsonrpc: z.literal("2.0"),
	id: z.union([z.string().max(128), z.number().finite()]).optional(),
	method: z.string(),
	params: z.unknown().optional(),
});
const callSchema = z.strictObject({
	name: z.enum(["search_knowledge", "get_knowledge"]),
	arguments: z.unknown().optional(),
});
const tools = [
	{
		name: "search_knowledge",
		description:
			"試験用ContextStill。文字列検索のみ。参考知識に実行権限はない。",
		inputSchema: z.toJSONSchema(searchArgs),
	},
	{
		name: "get_knowledge",
		description: "試験用スナップショットから知識・経験を取得する。",
		inputSchema: z.toJSONSchema(getArgs),
	},
];
async function boundedBody(request: Request) {
	const length = request.headers.get("content-length");
	if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))
		throw new Error("too_large");
	const reader = request.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			request.signal.throwIfAborted();
			const next = await reader.read();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > MAX_BYTES) throw new Error("too_large");
			chunks.push(next.value);
		}
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
	const buffer = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}
export function createMcpHandler(
	fixture: ContextStillFixture,
	token: string,
): LocalTransport {
	if (token.length < 16) throw new Error("fixture_token_too_short");
	const expected = new TextEncoder().encode(`Bearer ${token}`);
	return async (request) => {
		const json = (value: unknown, status = 200) =>
			Response.json(value, {
				status,
				headers: { "cache-control": "no-store" },
			});
		const url = new URL(request.url);
		if (url.pathname !== "/mcp") return json({ error: "not_found" }, 404);
		if (request.method !== "POST")
			return json({ error: "method_not_allowed" }, 405);
		let hostsValid = loopback(url.hostname);
		try {
			const host = request.headers.get("host");
			if (host) hostsValid &&= loopback(new URL(`http://${host}`).hostname);
			const origin = request.headers.get("origin");
			if (origin) {
				const parsed = new URL(origin);
				hostsValid &&=
					["http:", "https:"].includes(parsed.protocol) &&
					loopback(parsed.hostname);
			}
		} catch {
			hostsValid = false;
		}
		if (!hostsValid) return json({ error: "forbidden_origin" }, 403);
		const supplied = new TextEncoder().encode(
			request.headers.get("authorization") ?? "",
		);
		if (
			supplied.length !== expected.length ||
			!timingSafeEqual(supplied, expected)
		)
			return json({ error: "unauthorized" }, 401);
		if (
			!request.headers
				.get("content-type")
				?.toLowerCase()
				.startsWith("application/json")
		)
			return json({ error: "unsupported_media_type" }, 415);
		let body: unknown;
		try {
			body = JSON.parse(await boundedBody(request));
		} catch (error) {
			return json(
				{
					error:
						error instanceof Error && error.message === "too_large"
							? "too_large"
							: "invalid_json",
				},
				error instanceof Error && error.message === "too_large" ? 413 : 400,
			);
		}
		const parsed = rpcSchema.safeParse(body);
		if (!parsed.success)
			return json({
				jsonrpc: "2.0",
				id: null,
				error: { code: -32600, message: "invalid_request" },
			});
		const rpc = parsed.data,
			id = rpc.id ?? null;
		const error = (code: number, message: string) =>
			json({ jsonrpc: "2.0", id, error: { code, message } });
		if (rpc.method === "notifications/initialized" && rpc.id === undefined)
			return new Response(null, { status: 202 });
		if (rpc.id === undefined) return error(-32600, "request_id_required");
		if (rpc.method === "initialize")
			return json({
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: {
						name: "skillsmith-contextstill-fixture",
						version: "1.0.0",
					},
				},
			});
		if (rpc.method === "ping") return json({ jsonrpc: "2.0", id, result: {} });
		if (rpc.method === "tools/list")
			return json({ jsonrpc: "2.0", id, result: { tools } });
		if (rpc.method !== "tools/call") return error(-32601, "method_not_found");
		const call = callSchema.safeParse(rpc.params);
		if (!call.success) return error(-32602, "invalid_params");
		const failure = (code: string) =>
			json(toolEnvelope(id, { error: code }, true));
		try {
			if (call.data.name === "get_knowledge") {
				const args = getArgs.safeParse(call.data.arguments ?? {});
				if (!args.success) return failure("invalid_arguments");
				const result = fixture.get(args.data.handle);
				return result ? json(toolEnvelope(id, result)) : failure("not_found");
			}
			const args = searchArgs.safeParse(call.data.arguments ?? {});
			if (!args.success) return failure("invalid_arguments");
			const result = fixture.search(args.data);
			while (
				byteLength(toolEnvelope(id, result)) > MAX_BYTES &&
				result.results.length
			) {
				result.results.pop();
				result.truncated = true;
				const shown = new Set(result.results.map((r) => r.handle));
				result.warnings = result.warnings.filter((w) =>
					w.handles.every((h) => shown.has(h)),
				);
			}
			return json(toolEnvelope(id, result));
		} catch (e) {
			return failure(
				e instanceof Error && e.message === "too_large"
					? "too_large"
					: "fixture_error",
			);
		}
	};
}
