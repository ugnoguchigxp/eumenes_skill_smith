import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { FORMAT, itemSchema } from "./contracts.js";

export const SEED_FORMAT = "skillsmith-contextstill-seed.v1";
export const DEFAULT_SEED = join(import.meta.dir, "seed");
export const DEFAULT_DATABASE = resolve(
	import.meta.dir,
	"../../data/contextstill/seed.sqlite",
);
export const sha256 = (data: string | Uint8Array) =>
	createHash("sha256").update(data).digest("hex");
const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_DATA_BYTES = 64 * 1024 * 1024;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const knowledgeHandle = z.string().regex(/^kn_[a-z2-7]{26}$/);
const knowledge = itemSchema.options[0].extend({
	handle: knowledgeHandle,
	status: z.enum(["candidate", "active", "superseded"]),
	examples: itemSchema.options[0].shape.examples.max(0),
	supersededBy: knowledgeHandle.nullable(),
});
export const seedRecordSchema = z.discriminatedUnion("record", [
	z.strictObject({
		record: z.literal("knowledge"),
		scope: z.literal("global"),
		revision: z.number().int().nonnegative(),
		retrieval: z.enum(["searchable", "evidence_only"]),
		item: knowledge,
	}),
	z.strictObject({
		record: z.literal("conflict"),
		handles: z.tuple([knowledgeHandle, knowledgeHandle]),
	}),
]);
export const seedManifestSchema = z.strictObject({
	format: z.literal(SEED_FORMAT),
	fixtureFormat: z.literal(FORMAT),
	license: z.literal("MIT"),
	file: z.literal("knowledge.jsonl.gz"),
	sha256: hashSchema,
	dataSha256: hashSchema,
	dataBytes: z.number().int().positive().max(MAX_DATA_BYTES),
	counts: z.strictObject({
		knowledge: z.number().int().positive(),
		episode: z.literal(0),
		conflicts: z.number().int().nonnegative(),
	}),
	source: z.strictObject({
		project: z.literal("ContextStill"),
		commit: z
			.string()
			.regex(/^[a-f0-9]{40}$/)
			.nullable(),
		snapshotAt: z.string().min(1),
	}),
	omitted: z.array(z.string()),
});
export type SeedRecord = z.infer<typeof seedRecordSchema>;
export type SeedManifest = z.infer<typeof seedManifestSchema>;

export function validateSeed(records: SeedRecord[], manifest: SeedManifest) {
	const items = records.filter((r) => r.record === "knowledge");
	const conflicts = records.filter((r) => r.record === "conflict");
	if (
		items.length !== manifest.counts.knowledge ||
		conflicts.length !== manifest.counts.conflicts
	)
		throw new Error("seed_count_mismatch");
	const byHandle = new Map(items.map((row) => [row.item.handle, row]));
	if (byHandle.size !== items.length) throw new Error("seed_duplicate_handle");
	for (const row of items) {
		if (row.retrieval !== "searchable" && row.item.status !== "superseded")
			throw new Error("seed_item_not_visible");
		if (row.item.supersededBy) {
			const successor = byHandle.get(row.item.supersededBy)?.item;
			if (
				!successor ||
				successor.status !== "active" ||
				successor.layer !== "canonical"
			)
				throw new Error("seed_successor_unavailable");
		}
	}
	const seen = new Set<string>();
	for (const row of conflicts) {
		const key = [...row.handles].sort().join(":");
		if (row.handles[0] === row.handles[1] || seen.has(key))
			throw new Error("seed_invalid_conflict");
		seen.add(key);
		for (const handle of row.handles) {
			const item = byHandle.get(handle)?.item;
			if (!item || item.status !== "active" || item.layer !== "canonical")
				throw new Error("seed_conflict_unavailable");
		}
	}
}

export function loadSeed(directory = DEFAULT_SEED) {
	const manifest = seedManifestSchema.parse(
		JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")),
	);
	const path = join(directory, manifest.file);
	if (statSync(path).size > MAX_COMPRESSED_BYTES)
		throw new Error("seed_compressed_too_large");
	const compressed = readFileSync(path);
	if (sha256(compressed) !== manifest.sha256)
		throw new Error("seed_checksum_mismatch");
	const bytes = gunzipSync(compressed, { maxOutputLength: MAX_DATA_BYTES });
	if (
		bytes.byteLength !== manifest.dataBytes ||
		sha256(bytes) !== manifest.dataSha256
	)
		throw new Error("seed_data_mismatch");
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	if (!text.endsWith("\n")) throw new Error("seed_missing_final_newline");
	const records = text
		.slice(0, -1)
		.split("\n")
		.map((line) => seedRecordSchema.parse(JSON.parse(line)));
	validateSeed(records, manifest);
	return { manifest, records };
}

export function seedDatabase(
	options: { destination?: string; directory?: string; replace?: boolean } = {},
) {
	const target = resolve(options.destination ?? DEFAULT_DATABASE);
	const { manifest, records } = loadSeed(options.directory);
	if (existsSync(target)) {
		if (!options.replace)
			throw new Error("seed_destination_exists_use_replace");
		if (lstatSync(target).isSymbolicLink())
			throw new Error("seed_destination_symlink");
		const existing = new Database(target, { readonly: true });
		try {
			const marker = existing
				.query<{ value: string }, []>(
					"SELECT value FROM fixture_metadata WHERE key='format'",
				)
				.get();
			if (JSON.parse(marker?.value ?? "null") !== FORMAT)
				throw new Error("seed_destination_not_fixture");
		} finally {
			existing.close();
		}
	}
	mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
	const temporary = join(
		dirname(target),
		`.seed-${crypto.randomUUID()}.sqlite`,
	);
	closeSync(openSync(temporary, "wx", 0o600));
	try {
		const db = new Database(temporary);
		try {
			db.exec("PRAGMA foreign_keys=ON");
			db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
			db.transaction(() => {
				const insert = db.query(
					"INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
				);
				for (const row of records) {
					if (row.record !== "knowledge") continue;
					const item = row.item;
					const searchText = [
						item.situation,
						item.body,
						item.rationale,
						...item.appliesWhen,
						...item.notAppliesWhen,
						...item.steps,
					].join("\n");
					insert.run(
						item.handle,
						item.kind,
						item.type,
						item.space,
						row.scope,
						item.status,
						row.retrieval,
						item.layer,
						row.revision,
						item.title,
						searchText,
						JSON.stringify(item),
					);
				}
				for (const row of records)
					if (row.record === "conflict")
						db.query("INSERT INTO conflicts VALUES(?,?)").run(...row.handles);
				db.exec("INSERT INTO items_fts(items_fts) VALUES('rebuild')");
				const metadata = {
					format: FORMAT,
					snapshotAt: manifest.source.snapshotAt,
					sourceCommit: manifest.source.commit,
					counts: { knowledge: manifest.counts.knowledge, episode: 0 },
					seedFormat: manifest.format,
					seedDigest: manifest.sha256,
					license: manifest.license,
					omitted: manifest.omitted,
					projection:
						"public knowledge seed; no episodes or episode-derived examples",
				};
				for (const [key, value] of Object.entries(metadata))
					db.query("INSERT INTO fixture_metadata VALUES(?,?)").run(
						key,
						JSON.stringify(value),
					);
			})();
			if (
				db
					.query<{ integrity_check: string }, []>("PRAGMA integrity_check")
					.get()?.integrity_check !== "ok"
			)
				throw new Error("seed_integrity_failed");
		} finally {
			db.close();
		}
		if (options.replace) renameSync(temporary, target);
		else {
			linkSync(temporary, target);
			rmSync(temporary);
		}
		return {
			destination: target,
			counts: manifest.counts,
			sha256: manifest.sha256,
		};
	} finally {
		rmSync(temporary, { force: true });
	}
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			dest: { type: "string" },
			"seed-dir": { type: "string" },
			replace: { type: "boolean", default: false },
		},
	});
	const result = seedDatabase({
		destination: values.dest,
		directory: values["seed-dir"],
		replace: values.replace,
	});
	console.log(JSON.stringify({ status: "seeded", ...result }));
}
