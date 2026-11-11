import { z } from "zod";
import { evidenceSchema, sourceSearchSchema } from "../contracts/schema.js";
import type { ExecutionContext, Ports } from "../contracts/ports.js";
import { digest, requireThat } from "../service/identity.js";

const handle = z.string().regex(/^(kn|ep)_[a-z2-7]{26}$/);
const space = z.enum(["coding", "general", "eumenes"]);
const trust = z.object({
	trustClass: z.literal("untrusted_knowledge_evidence"),
	instructionAuthority: z.literal("none"),
});
const item = z.object({
	handle,
	revision: z.number().int().positive(),
	title: z.string().trim().min(1),
	status: z.string(),
	space,
});
const searchResult = z.object({
	contractVersion: z.literal("contextstill-search.v1"),
	trust,
	results: z.array(item).max(20),
	warnings: z.array(z.object({ kind: z.string(), handles: z.array(handle) })),
	degraded: z.array(z.string()),
	truncated: z.boolean(),
});
const documentResult = z.object({
	contractVersion: z.literal("contextstill-knowledge.v1"),
	trust,
	item: item
		.extend({
			contentTruncated: z.boolean(),
			evidenceTruncated: z.boolean(),
			supersededBy: handle.nullable().optional(),
		})
		.passthrough(),
});
const envelope = z.object({
	jsonrpc: z.literal("2.0"),
	id: z.string(),
	result: z.unknown(),
});
const toolResult = z.object({
	content: z.tuple([z.object({ type: z.literal("text"), text: z.string() })]),
	isError: z.boolean().optional(),
});
const setupResult = z.object({
	protocolVersion: z.literal("2025-03-26"),
	serverInfo: z.object({ name: z.literal("context-still") }),
	capabilities: z.object({ tools: z.object({}) }),
});
const toolList = z.object({ tools: z.array(z.object({ name: z.string() })) });
const prefix = "contextstill:";
const allowedSpaces = space.options;
const usableStatus = (status: string) =>
	status === "active" || status === "superseded";
const refFor = (id: string) => prefix + id;
const handleFor = (ref: string) => {
	requireThat(ref.startsWith(prefix), "source_contract_violation");
	return handle.parse(ref.slice(prefix.length));
};
const version = (ref: string, revision: number, checksum: string) => ({
	id: ref,
	version: String(revision),
	digest: checksum,
	generation: 0,
});
const cardFields = (row: z.infer<typeof item>) => ({
	ref: refFor(row.handle),
	title: [...row.title].slice(0, 500).join(""),
	status:
		row.status === "superseded" ? ("superseded" as const) : ("active" as const),
	scope: "shared",
	external: true,
});

async function boundedJson(response: Response, signal: AbortSignal) {
	const reader = response.body?.getReader();
	requireThat(reader, "source_contract_violation");
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let size = 0,
		body = "";
	try {
		for (;;) {
			signal.throwIfAborted();
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			requireThat(size <= 32768, "source_contract_violation");
			body += decoder.decode(part.value, { stream: true });
		}
		return JSON.parse(body + decoder.decode()) as unknown;
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
}

/** Public, read-only MCP. The host supplies its endpoint, token and authorized search text. */
export function createContextStillSource(options: {
	endpoint: string;
	token: string;
	fetch?: typeof globalThis.fetch;
}): NonNullable<Ports<unknown>["source"]> {
	const endpoint = new URL(options.endpoint);
	requireThat(
		(endpoint.protocol === "https:" ||
			(endpoint.protocol === "http:" &&
				["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))) &&
			!endpoint.username &&
			!endpoint.password &&
			!endpoint.search &&
			!endpoint.hash &&
			endpoint.pathname === "/mcp" &&
			options.token.trim().length >= 24,
		"invalid_contextstill_connection",
	);
	const send = options.fetch ?? globalThis.fetch;
	let checked = false;
	async function rpc(
		method: string,
		params: unknown,
		signal: AbortSignal,
		context?: ExecutionContext,
	) {
		signal.throwIfAborted();
		await context?.reserve("sourceCalls");
		signal.throwIfAborted();
		const started = performance.now();
		let outcome: "ok" | "error" = "error";
		try {
			const id =
				method === "notifications/initialized"
					? undefined
					: crypto.randomUUID();
			const response = await send(endpoint, {
				method: "POST",
				redirect: "error",
				headers: {
					authorization: "Bearer " + options.token,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
				signal,
			});
			if (!response.ok) {
				await response.body?.cancel();
				throw Error("contextstill_http_failure");
			}
			if (id === undefined) {
				await response.body?.cancel();
				requireThat(response.status === 202, "source_contract_violation");
				outcome = "ok";
				return null;
			}
			const reply = envelope.parse(await boundedJson(response, signal));
			requireThat(
				reply.id === id && reply.result !== undefined,
				"source_contract_violation",
			);
			outcome = "ok";
			return reply.result;
		} finally {
			context?.noteCall?.({
				kind: "sourceCalls",
				operation: method,
				outcome,
				durationMs: performance.now() - started,
			});
		}
	}
	async function tool(
		name: "search_knowledge" | "get_knowledge",
		args: unknown,
		signal: AbortSignal,
		context?: ExecutionContext,
	) {
		if (!checked) {
			setupResult.parse(
				await rpc(
					"initialize",
					{
						protocolVersion: "2025-03-26",
						capabilities: {},
						clientInfo: { name: "skillsmith", version: "1" },
					},
					signal,
					context,
				),
			);
			await rpc("notifications/initialized", {}, signal, context);
			const list = toolList.parse(await rpc("tools/list", {}, signal, context));
			requireThat(
				["search_knowledge", "get_knowledge"].every((required) =>
					list.tools.some(({ name }) => name === required),
				),
				"source_contract_violation",
			);
			checked = true;
		}
		const result = toolResult.parse(
			await rpc("tools/call", { name, arguments: args }, signal, context),
		);
		const payload: unknown = JSON.parse(result.content[0].text);
		if (result.isError) {
			if (
				z.object({ error: z.literal("not_found") }).safeParse(payload).success
			)
				return null;
			throw Error("contextstill_tool_failure");
		}
		return payload;
	}
	const get: NonNullable<Ports<unknown>["source"]>["get"] = async (
		ref,
		signal,
		context,
	) => {
		const id = handleFor(ref);
		const raw = await tool("get_knowledge", { handle: id }, signal, context);
		if (!raw) throw Error("contextstill_not_found");
		const data = documentResult.parse(raw);
		const row = data.item;
		requireThat(
			row.handle === id && usableStatus(row.status),
			"source_revoked",
		);
		const body = JSON.stringify(data);
		return evidenceSchema.parse({
			...cardFields(row),
			version: version(ref, row.revision, digest(data)),
			complete: !row.contentTruncated && !row.evidenceTruncated,
			...(row.supersededBy && row.status === "superseded"
				? { supersededBy: refFor(row.supersededBy) }
				: {}),
			body,
		});
	};
	return {
		meteredCalls: true,
		async search(query, limit, signal, context) {
			const data = searchResult.parse(
				await tool(
					"search_knowledge",
					{
						query,
						limit: Math.min(limit, 20),
						spaces: allowedSpaces,
						kinds: ["knowledge", "episode"],
					},
					signal,
					context,
				),
			);
			const cards = data.results
				.filter((row) => usableStatus(row.status))
				.map((row) => {
					const card = cardFields(row);
					return {
						...card,
						revisionOnly: true as const,
						complete: false,
						version: version(
							card.ref,
							row.revision,
							digest([card.ref, row.revision]),
						),
					};
				});
			const visible = new Set(cards.map(({ ref }) => ref));
			return sourceSearchSchema.parse({
				cards,
				warnings: data.warnings
					.map(({ kind, handles }) => ({ kind, refs: handles.map(refFor) }))
					.filter(({ refs }) => refs.every((ref) => visible.has(ref))),
				degraded: data.degraded,
				truncated: data.truncated || limit > 20,
			});
		},
		get,
		async validate(refs, signal, context) {
			for (const ref of refs) {
				if (!ref.external) return false;
				try {
					const current = await get(ref.ref, signal, context);
					if (
						!current.complete ||
						current.status !== "active" ||
						digest(current.version) !== digest(ref.version)
					)
						return false;
				} catch (error) {
					if (
						error instanceof Error &&
						error.message === "contextstill_not_found"
					)
						return false;
					throw error;
				}
			}
			return true;
		},
	};
}
