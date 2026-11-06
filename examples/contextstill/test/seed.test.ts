import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { DEFAULT_SEED, loadSeed, seedDatabase, sha256 } from "../seed.js";
import { exportSeed } from "../export-seed.js";
import { ContextStillFixture } from "../database.js";
import { createMcpHandler } from "../mcp.js";
import { createFixtureSource } from "../source.js";
import { createExampleHost } from "../host.js";
import { episode, handle, item, setup } from "./fixture.js";

const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), "skillsmith-seed-"));
	directories.push(dir);
	return dir;
};

test("committed seed creates a public knowledge-only SQLite with matching provenance and restricted mode", () => {
	const path = join(temp(), "data", "seed.sqlite");
	const result = seedDatabase({ destination: path });
	const fixture = new ContextStillFixture(path);
	try {
		expect(fixture.counts()).toEqual([
			{ kind: "knowledge", count: result.counts.knowledge },
		]);
		expect(fixture.metadata().seedDigest).toBe(result.sha256);
		expect(result.counts.knowledge).toBeGreaterThan(0);
		expect(result.counts.episode).toBe(0);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		const db = new Database(path, { readonly: true });
		try {
			expect(
				db
					.query(
						"SELECT handle FROM items WHERE scope!='global' OR space='personal' OR kind!='knowledge'",
					)
					.all(),
			).toEqual([]);
			expect(
				db
					.query(
						"SELECT handle FROM items WHERE json_array_length(document_json,'$.examples')!=0",
					)
					.all(),
			).toEqual([]);
			expect(
				db
					.query(
						"SELECT name FROM sqlite_schema WHERE name IN ('settings_credentials','episodes','source_records')",
					)
					.all(),
			).toEqual([]);
		} finally {
			db.close();
		}
	} finally {
		fixture.close();
	}
});

test("committed seed works through the mock and SkillSmith without the source DB or service", async () => {
	const path = join(temp(), "seed.sqlite");
	seedDatabase({ destination: path });
	const fixture = new ContextStillFixture(path),
		token = crypto.randomUUID();
	const host = createExampleHost(
		createFixtureSource(createMcpHandler(fixture, token), token),
		"検証",
	);
	try {
		const reply = await host.run();
		expect(reply.kind).toBe("ready");
		if (reply.kind !== "ready") throw new Error("seed_expected_ready");
		expect(reply.build.content.dependencies[0]?.external).toBe(true);
		expect(reply.build.usage.modelCalls).toBe(1);
	} finally {
		host.close();
		fixture.close();
	}
});

test("seed export is deterministic and removes episode records and episode-derived examples", () => {
	const f = setup([
		item({
			examples: [
				{
					situation: "episode-only text",
					action: "act",
					outcome: "done",
					episodes: [handle("b", "ep")],
				},
			],
		}),
		episode(),
	]);
	f.writer.exec("PRAGMA ignore_check_constraints=ON");
	f.put(item({ handle: handle("c"), body: "repo-only" }), { scope: "repo" });
	f.put(item({ handle: handle("d"), body: "personal-only" }), {
		space: "personal",
	});
	const a = temp(),
		b = temp();
	const before = sha256(readFileSync(f.path));
	exportSeed(f.path, a);
	exportSeed(f.path, b);
	expect(readFileSync(join(a, "knowledge.jsonl.gz"))).toEqual(
		readFileSync(join(b, "knowledge.jsonl.gz")),
	);
	expect(readFileSync(join(a, "manifest.json"))).toEqual(
		readFileSync(join(b, "manifest.json")),
	);
	const data = loadSeed(a);
	expect(data.records).toHaveLength(1);
	expect(
		data.records[0]?.record === "knowledge" && data.records[0].item.examples,
	).toEqual([]);
	expect(sha256(readFileSync(f.path))).toBe(before);
});

test("checksum and count mismatches fail before creating a DB", () => {
	const dir = temp();
	cpSync(DEFAULT_SEED, dir, { recursive: true });
	const file = join(dir, "knowledge.jsonl.gz"),
		bytes = readFileSync(file);
	bytes[10] = bytes[10]! ^ 1;
	writeFileSync(file, bytes);
	const target = join(temp(), "seed.sqlite");
	expect(() => seedDatabase({ destination: target, directory: dir })).toThrow(
		"seed_checksum_mismatch",
	);
	expect(existsSync(target)).toBe(false);
	cpSync(DEFAULT_SEED, dir, { recursive: true });
	const manifest = loadSeed(dir).manifest;
	manifest.counts.knowledge++;
	writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
	expect(() => seedDatabase({ destination: target, directory: dir })).toThrow(
		"seed_count_mismatch",
	);
	expect(existsSync(target)).toBe(false);
});

test("even correctly hashed bundles reject private scope, personal space, episode examples and extra fields", () => {
	const f = setup([item()]);
	for (const change of ["scope", "space", "episode", "example", "extra"]) {
		const dir = temp();
		exportSeed(f.path, dir);
		const { records, manifest } = loadSeed(dir);
		const row = records[0]!;
		if (row.record !== "knowledge") throw new Error("expected_knowledge");
		const altered: Record<string, unknown> = structuredClone(row);
		if (change === "scope") altered.scope = "repo";
		if (change === "space")
			(altered.item as Record<string, unknown>).space = "personal";
		if (change === "episode")
			(altered.item as Record<string, unknown>).kind = "episode";
		if (change === "example")
			(altered.item as Record<string, unknown>).examples = [
				{
					situation: "not public",
					action: "x",
					outcome: "x",
					episodes: [handle("b", "ep")],
				},
			];
		if (change === "extra") altered.credentials = "never include settings";
		const text = JSON.stringify(altered) + "\n",
			compressed = gzipSync(Buffer.from(text));
		writeFileSync(join(dir, "knowledge.jsonl.gz"), compressed);
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify({
				...manifest,
				sha256: sha256(compressed),
				dataSha256: sha256(text),
				dataBytes: Buffer.byteLength(text),
			}),
		);
		expect(() => loadSeed(dir)).toThrow();
	}
});

test("duplicate handles and unavailable successor/conflict references are rejected", () => {
	const f = setup([item()]);
	for (const change of ["duplicate", "successor", "conflict"]) {
		const dir = temp();
		exportSeed(f.path, dir);
		const { records, manifest } = loadSeed(dir),
			row = records[0]!;
		if (row.record !== "knowledge") throw new Error("expected_knowledge");
		if (change === "duplicate") {
			records.push(row);
			manifest.counts.knowledge++;
		}
		if (change === "successor") row.item.supersededBy = handle("z");
		if (change === "conflict") {
			records.push({ record: "conflict", handles: [handle("a"), handle("z")] });
			manifest.counts.conflicts++;
		}
		const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n",
			compressed = gzipSync(Buffer.from(text));
		writeFileSync(join(dir, "knowledge.jsonl.gz"), compressed);
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify({
				...manifest,
				sha256: sha256(compressed),
				dataSha256: sha256(text),
				dataBytes: Buffer.byteLength(text),
			}),
		);
		expect(() => loadSeed(dir)).toThrow(
			change === "duplicate"
				? "seed_duplicate_handle"
				: change === "successor"
					? "seed_successor_unavailable"
					: "seed_conflict_unavailable",
		);
	}
});

test("existing fixtures require replace and an unrelated DB is never overwritten", () => {
	const f = setup([item()]),
		dir = temp();
	exportSeed(f.path, dir);
	const path = join(temp(), "seed.sqlite");
	seedDatabase({ destination: path, directory: dir });
	const before = sha256(readFileSync(path));
	expect(() => seedDatabase({ destination: path, directory: dir })).toThrow(
		"seed_destination_exists_use_replace",
	);
	expect(sha256(readFileSync(path))).toBe(before);
	expect(
		seedDatabase({ destination: path, directory: dir, replace: true }).counts
			.knowledge,
	).toBe(1);
	const other = join(temp(), "other.sqlite"),
		db = new Database(other);
	db.exec("CREATE TABLE user_data(value TEXT)");
	db.close();
	const otherHash = sha256(readFileSync(other));
	expect(() =>
		seedDatabase({ destination: other, directory: dir, replace: true }),
	).toThrow();
	expect(sha256(readFileSync(other))).toBe(otherHash);
});
