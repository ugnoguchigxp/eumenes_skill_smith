import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { canonical } from "../../src/index.js";
import { FORMAT } from "./contracts.js";
import {
	DEFAULT_SEED,
	SEED_FORMAT,
	seedManifestSchema,
	seedRecordSchema,
	sha256,
	validateSeed,
} from "./seed.js";
import type { SeedRecord } from "./seed.js";

/** Explicit maintenance export of user-authorized knowledge; never includes episode text. */
export function exportSeed(source: string, directory = DEFAULT_SEED) {
	const db = new Database(source, { readonly: true });
	try {
		const { records, provenance } = db.transaction(() => {
			const metadata = Object.fromEntries(
				db
					.query<{ key: string; value: string }, []>(
						"SELECT key,value FROM fixture_metadata",
					)
					.all()
					.map((r) => [r.key, JSON.parse(r.value) as unknown]),
			);
			if (metadata.format !== FORMAT)
				throw new Error("fixture_snapshot_required");
			const rows = db
				.query<
					{ revision: number; retrieval: string; document_json: string },
					[]
				>(
					"SELECT revision,retrieval,document_json FROM items WHERE kind='knowledge' AND scope='global' AND space IN ('coding','general','eumenes') AND status!='retracted' AND (retrieval='searchable' OR status='superseded') ORDER BY handle",
				)
				.all();
			const records: SeedRecord[] = rows.map((row) =>
				seedRecordSchema.parse({
					record: "knowledge",
					scope: "global",
					revision: row.revision,
					retrieval: row.retrieval,
					item: {
						...(JSON.parse(row.document_json) as Record<string, unknown>),
						examples: [],
					},
				}),
			);
			const included = new Set(
				records.flatMap((row) =>
					row.record === "knowledge" ? [row.item.handle] : [],
				),
			);
			for (const row of db
				.query<{ a: string; b: string }, []>(
					"SELECT a,b FROM conflicts ORDER BY a,b",
				)
				.all())
				if (included.has(row.a) && included.has(row.b))
					records.push(
						seedRecordSchema.parse({
							record: "conflict",
							handles: [row.a, row.b],
						}),
					);
			return {
				records,
				provenance: {
					project: "ContextStill",
					commit: metadata.sourceCommit ?? null,
					snapshotAt: metadata.snapshotAt,
				},
			};
		})();
		const data = records.map(canonical).join("\n") + "\n";
		const compressed = gzipSync(Buffer.from(data), { level: 9 });
		const manifest = seedManifestSchema.parse({
			format: SEED_FORMAT,
			fixtureFormat: FORMAT,
			license: "MIT",
			file: "knowledge.jsonl.gz",
			sha256: sha256(compressed),
			dataSha256: sha256(data),
			dataBytes: Buffer.byteLength(data),
			counts: {
				knowledge: records.filter((r) => r.record === "knowledge").length,
				episode: 0,
				conflicts: records.filter((r) => r.record === "conflict").length,
			},
			source: provenance,
			omitted: [
				"episodes",
				"episode_examples",
				"settings",
				"credentials",
				"keys",
				"raw_sources",
				"source_excerpts",
				"source_urls",
				"personal",
				"repo_scope",
				"vectors",
				"logs",
				"themes",
			],
		});
		validateSeed(records, manifest);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, manifest.file), compressed);
		writeFileSync(
			join(directory, "manifest.json"),
			JSON.stringify(manifest, null, "\t") + "\n",
		);
		return manifest;
	} finally {
		db.close();
	}
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			source: { type: "string", default: "data/contextstill/snapshot.sqlite" },
			dest: { type: "string", default: DEFAULT_SEED },
		},
	});
	const manifest = exportSeed(resolve(values.source), resolve(values.dest));
	console.log(
		JSON.stringify({
			status: "exported",
			counts: manifest.counts,
			sha256: manifest.sha256,
			dataBytes: manifest.dataBytes,
		}),
	);
}
