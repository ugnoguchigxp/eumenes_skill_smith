import {
	openSync,
	writeSync,
	fsyncSync,
	closeSync,
	readFileSync,
	existsSync,
} from "node:fs";
import { digest, type Ports } from "../../src/index.js";
import { providerSchema, decodeProviderValue } from "./provider-schema.js";

export type CloudModel = {
	id: string;
	inputUsdPerMillion: number;
	outputUsdPerMillion: number;
	reasoningEffort?: "low" | "medium" | "high";
};
type Input = Parameters<Ports<unknown>["inference"]["complete"]>[0];
async function readJSON(response: Response, signal: AbortSignal) {
	const reader = response.body?.getReader();
	if (!reader) throw Error("cloud_empty_response");
	let bytes = 0;
	const chunks: Uint8Array[] = [];
	try {
		while (true) {
			signal.throwIfAborted();
			const next = await reader.read();
			signal.throwIfAborted();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > 2 * 1024 * 1024) throw Error("cloud_response_too_large");
			chunks.push(next.value);
		}
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
	const body = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(body));
}
type Entry = {
	id: string;
	reservedUsd: number;
	costUsd?: number;
	durationMs?: number;
	inputTokens?: number;
	outputTokens?: number;
	model: string;
	purpose: string;
	requestDigest: string;
	responseId?: string;
};

/** Eval-only direct text API. Caller exclusively owns journal; unknown costs retain the reservation. */
export function createCloudBudget(options: {
	baseUrl: string;
	credential: string;
	maxUsd: number;
	journal: string;
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	onSchemaFailure?: (message: string) => void;
}) {
	const events: Entry[] = existsSync(options.journal)
		? readFileSync(options.journal, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
	const latest = () => new Map(events.map((entry) => [entry.id, entry]));
	const spent = () =>
		[...latest().values()].reduce(
			(sum, entry) => sum + (entry.costUsd ?? entry.reservedUsd),
			0,
		);
	const record = (entry: Entry) => {
		const fd = openSync(options.journal, "a", 0o600);
		try {
			writeSync(fd, JSON.stringify(entry) + "\n");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		events.push(entry);
	};
	const inFlight = new Set<string>();
	const changed = new Set<() => void>();
	const waitForSettlement = (signal: AbortSignal) =>
		new Promise<void>((resolve, reject) => {
			const clear = () => {
				changed.delete(onChange);
				signal.removeEventListener("abort", onAbort);
			};
			const onChange = () => {
				clear();
				resolve();
			};
			const onAbort = () => {
				clear();
				reject(signal.reason);
			};
			changed.add(onChange);
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		});
	return {
		spent,
		events: () => structuredClone([...latest().values()]),
		async complete(
			model: CloudModel,
			purpose: string,
			input: Input,
			signal: AbortSignal,
		) {
			if (
				![
					options.maxUsd,
					model.inputUsdPerMillion,
					model.outputUsdPerMillion,
				].every((value) => Number.isFinite(value) && value >= 0)
			)
				throw Error("invalid_cloud_budget");
			if (
				!Number.isSafeInteger(input.maxOutputTokens) ||
				input.maxOutputTokens < 1 ||
				input.maxOutputTokens > 8192
			)
				throw Error("invalid_cloud_output_limit");
			signal.throwIfAborted();
			// Provider-specific structural constraints are adapted; unchanged host schemas validate the answer.
			const body = JSON.stringify({
				model: model.id,
				...(model.reasoningEffort
					? { reasoning: { effort: model.reasoningEffort } }
					: {}),
				instructions:
					input.system +
					"\nReturn the result in the provider schema's result field. Optional fields use null when omitted.",
				input: JSON.stringify({ data: input.data, schema: input.schema }),
				text: {
					format: {
						type: "json_schema",
						name: "skillsmith",
						strict: true,
						schema: {
							type: "object",
							properties: { result: providerSchema(input.schema) },
							required: ["result"],
							additionalProperties: false,
						},
					},
				},
				max_output_tokens: input.maxOutputTokens,
				service_tier: "default",
				store: false,
			});
			const bytes = Buffer.byteLength(body);
			if (bytes > 131072) throw Error("cloud_input_too_large");
			// Text-only request: byte bound plus message overhead, at ten times the published standard rates.
			// The margin also covers regional/long-context pricing; no tools, caching writes or retries are requested.
			const reservedUsd =
				Math.ceil(
					((bytes + 4096) * model.inputUsdPerMillion +
						input.maxOutputTokens * model.outputUsdPerMillion) *
						10,
				) / 1e6;
			while (spent() + reservedUsd > options.maxUsd) {
				if (!inFlight.size) throw Error("cloud_cost_limit");
				await waitForSettlement(signal);
				signal.throwIfAborted();
			}
			const entry: Entry = {
				id: crypto.randomUUID(),
				reservedUsd,
				model: model.id,
				purpose,
				requestDigest: digest(input),
			};
			record(entry);
			inFlight.add(entry.id);
			try {
				const started = performance.now();
				const response = await (options.fetch ?? fetch)(
					options.baseUrl.replace(/\/$/, "") + "/responses",
					{
						method: "POST",
						headers: {
							authorization: "Bearer " + options.credential,
							"content-type": "application/json",
						},
						body,
						signal,
					},
				);
				if (!response.ok) {
					const detail = await readJSON(response, signal).catch(() => null);
					if (
						detail?.error?.code === "invalid_json_schema" &&
						detail?.error?.param === "text.format.schema" &&
						typeof detail?.error?.message === "string"
					)
						options.onSchemaFailure?.(detail.error.message.slice(0, 2000));
					const code = [detail?.error?.code, detail?.error?.param]
						.filter(
							(s) => typeof s === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(s),
						)
						.join("_");
					throw Error(
						"cloud_http_" + response.status + (code ? "_" + code : ""),
					);
				}
				const result = await readJSON(response, signal);
				const usage = result.usage;
				if (
					usage &&
					Number.isSafeInteger(usage.input_tokens) &&
					usage.input_tokens >= 0 &&
					Number.isSafeInteger(usage.output_tokens) &&
					usage.output_tokens >= 0
				) {
					const costUsd =
						(usage.input_tokens * model.inputUsdPerMillion +
							usage.output_tokens * model.outputUsdPerMillion) /
						1e6;
					if (costUsd > reservedUsd) throw Error("cloud_cost_bound_violated");
					record({
						...entry,
						costUsd,
						inputTokens: usage.input_tokens,
						outputTokens: usage.output_tokens,
						durationMs: performance.now() - started,
						responseId: typeof result.id === "string" ? result.id : undefined,
					});
				}
				if (result.status !== "completed") throw Error("cloud_incomplete");
				if (typeof result.id !== "string" || !result.id.length)
					throw Error("cloud_receipt_missing");
				const output = result.output
					?.filter((item: { type: string }) => item.type === "message")
					.flatMap(
						(item: { content: { type: string; text?: string }[] }) =>
							item.content,
					)
					.filter((part: { type: string }) => part.type === "output_text")
					.map((part: { text: string }) => part.text)
					.join("");
				return {
					value: decodeProviderValue(JSON.parse(output).result, input.schema),
					receipt: result.id as string,
					inputTokens: usage?.input_tokens ?? null,
					outputTokens: usage?.output_tokens ?? null,
					reasoningTokens:
						usage?.output_tokens_details?.reasoning_tokens ?? null,
					cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? null,
				};
			} finally {
				inFlight.delete(entry.id);
				for (const notify of changed) notify();
			}
		},
	};
}
