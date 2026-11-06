import { z } from "zod";
import type {
	Evidence,
	EvidenceCard,
	Ports,
	VersionRef,
} from "../../src/index.js";
import { digest } from "../../src/index.js";
import {
	MAX_BYTES,
	cardSchema,
	documentSchema,
	handleSchema,
	searchSchema,
} from "./contracts.js";
import type { LocalTransport } from "./mcp.js";

export type SourcePort = NonNullable<Ports<unknown>["source"]>;
const envelope = z.object({
	jsonrpc: z.literal("2.0"),
	id: z.string(),
	result: z.object({
		content: z.tuple([z.object({ type: z.literal("text"), text: z.string() })]),
		isError: z.boolean().optional(),
	}),
});
const warningSchema = z.object({
	kind: z.string(),
	handles: z.array(handleSchema).min(1),
});
const refOf = (handle: string) => `contextstill:${handle}`;
const handleOf = (ref: string) => {
	if (!ref.startsWith("contextstill:")) throw new Error("invalid_source_ref");
	return handleSchema.parse(ref.slice("contextstill:".length));
};
function version(
	handle: string,
	stamp: z.infer<typeof cardSchema>["_fixture"],
): VersionRef {
	return {
		id: refOf(handle),
		version: String(stamp.revision),
		digest: stamp.digest,
		generation: 0,
	};
}
function card(c: z.infer<typeof cardSchema>): EvidenceCard {
	return {
		ref: refOf(c.handle),
		version: version(c.handle, c._fixture),
		title: c.title,
		status: c.status === "active" ? "active" : "superseded",
		complete: c._fixture.complete,
		external: true,
		scope: "shared",
	};
}
/** Fixture-only adapter: requires _fixture stamps absent from the production ContextStill API. */
export function createFixtureSource(
	transport: LocalTransport,
	token: string,
): SourcePort {
	async function call(name: string, args: unknown, signal: AbortSignal) {
		signal.throwIfAborted();
		const id = crypto.randomUUID();
		const response = await transport(
			new Request("http://127.0.0.1/mcp", {
				method: "POST",
				signal,
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id,
					method: "tools/call",
					params: { name, arguments: args },
				}),
			}),
		);
		signal.throwIfAborted();
		if (!response.ok) throw new Error(`contextstill_http_${response.status}`);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("contextstill_empty_response");
		const decoder = new TextDecoder();
		let text = "",
			size = 0;
		try {
			while (true) {
				signal.throwIfAborted();
				const next = await reader.read();
				if (next.done) break;
				size += next.value.byteLength;
				if (size > MAX_BYTES)
					throw new Error("contextstill_response_too_large");
				text += decoder.decode(next.value, { stream: true });
			}
			text += decoder.decode();
		} finally {
			await reader.cancel();
			reader.releaseLock();
		}
		const rpc = envelope.parse(JSON.parse(text));
		if (rpc.id !== id) throw new Error("contextstill_id_mismatch");
		if (rpc.result.isError) throw new Error("contextstill_tool_error");
		return JSON.parse(rpc.result.content[0].text) as unknown;
	}
	const get: SourcePort["get"] = async (ref, signal) => {
		const handle = handleOf(ref);
		const doc = documentSchema.parse(
			await call("get_knowledge", { handle }, signal),
		);
		if (doc.item.handle !== handle)
			throw new Error("contextstill_handle_mismatch");
		// Preserve conditions, counterconditions, examples and provenance as untrusted data.
		return {
			...card({ ...doc.item, _fixture: doc._fixture }),
			body: JSON.stringify({
				...doc,
				fixtureLimitations: ["source_details_omitted", "themes_unavailable"],
			}),
		};
	};
	return {
		search: async (query, limit, signal) => {
			const r = searchSchema.parse(
				await call(
					"search_knowledge",
					{ query, limit, kinds: ["knowledge", "episode"] },
					signal,
				),
			);
			// Forward search-wide notices verbatim as structure; no interpretation here.
			return {
				cards: r.results.map(card),
				warnings: r.warnings.map((w) => {
					const parsed = warningSchema.parse(w);
					return { kind: parsed.kind, refs: parsed.handles.map(refOf) };
				}),
				degraded: r.degraded,
				truncated: r.truncated,
			};
		},
		get,
		validate: async (refs, signal) => {
			for (const ref of refs) {
				const current: Evidence = await get(ref.ref, signal);
				if (
					!ref.external ||
					current.status !== "active" ||
					!current.complete ||
					digest(current.version) !== digest(ref.version)
				)
					return false;
			}
			return true;
		},
	};
}
