import { titleKey } from "./title-key.js";
import { Database } from "bun:sqlite";
import { digest } from "../../src/index.js";
import {
	FORMAT,
	MAX_BYTES,
	TRUST,
	byteLength,
	itemSchema,
	toolEnvelope,
} from "./contracts.js";
import type { PublicItem, SearchArgs } from "./contracts.js";

export type SearchProfile = "handle" | "bm25";

interface Row {
	handle: string;
	revision: number;
	document_json: string;
}
const visible =
	"scope='global' AND space IN ('coding','general','eumenes') AND status!='retracted' AND (retrieval='searchable' OR status='superseded')";
const searchable = `${visible} AND status='active' AND retrieval='searchable'`;
const cut = (text: string, count: number) => [...text].slice(0, count).join("");
export { titleKey } from "./title-key.js";

export class ContextStillFixture {
	private readonly db: Database;
	constructor(
		path: string,
		readonly searchProfile: SearchProfile = "bm25",
	) {
		this.db = new Database(path, { readonly: true, strict: true });
		try {
			this.db.exec("PRAGMA query_only=ON");
			const marker = this.db
				.query<{ value: string }, []>(
					"SELECT value FROM fixture_metadata WHERE key='format'",
				)
				.get();
			if (JSON.parse(marker?.value ?? "null") !== FORMAT)
				throw new Error("wrong_format");
			if (
				!this.db
					.query<{ name: string }, []>("PRAGMA table_info(items)")
					.all()
					.some((c) => c.name === "title_key") ||
				!this.db
					.query<{ name: string }, []>("PRAGMA index_list(items)")
					.all()
					.some((i) => i.name === "items_title_key")
			)
				throw new Error("title_index_missing");
		} catch {
			this.db.close();
			throw new Error("fixture_snapshot_required");
		}
	}
	close() {
		this.db.close();
	}
	metadata() {
		return Object.fromEntries(
			this.db
				.query<{ key: string; value: string }, []>(
					"SELECT key,value FROM fixture_metadata ORDER BY key",
				)
				.all()
				.map((r) => [r.key, JSON.parse(r.value) as unknown]),
		);
	}
	counts() {
		return this.db
			.query<{ kind: string; count: number }, []>(
				"SELECT kind,count(*) AS count FROM items GROUP BY kind ORDER BY kind",
			)
			.all();
	}
	get(handle: string) {
		const row = this.db
			.query<Row, [string]>(
				`SELECT handle,revision,document_json FROM items WHERE handle=? AND ${visible}`,
			)
			.get(handle);
		return row ? this.document(row) : null;
	}
	private document(row: Row) {
		const original = itemSchema.parse(JSON.parse(row.document_json));
		const hash = digest(original);
		// Text clipping is explicit fixture metadata; the native MCP has no such flag.
		const render = (limit: number, evidenceCount: number) => {
			let clipped = false;
			const text = (s: string) => {
				const out = cut(s, limit);
				clipped ||= out !== s;
				return out;
			};
			const item: PublicItem = {
				...original,
				title: text(original.title),
				situation: text(original.situation),
				evidence: original.evidence.slice(0, evidenceCount),
				evidenceTruncated:
					original.evidenceTruncated ||
					evidenceCount < original.evidence.length,
			};
			if (item.kind === "knowledge" && original.kind === "knowledge") {
				item.body = text(original.body);
				item.rationale = text(original.rationale);
				item.exceptions = original.exceptions.map(text);
				item.appliesWhen = original.appliesWhen.map(text);
				item.notAppliesWhen = original.notAppliesWhen.map(text);
				item.steps = original.steps.map(text);
				item.examples = original.examples.map((e) => ({
					...e,
					situation: text(e.situation),
					action: text(e.action),
					outcome: text(e.outcome),
				}));
			} else if (item.kind === "episode" && original.kind === "episode") {
				item.intent = text(original.intent);
				item.decision = text(original.decision);
				item.observations = text(original.observations);
				item.action = text(original.action);
				item.outcome = text(original.outcome);
				item.lesson = text(original.lesson);
				item.openQuestions = original.openQuestions.map(text);
			}
			return {
				contractVersion: "contextstill-knowledge.v1" as const,
				trust: TRUST,
				item,
				_fixture: {
					format: FORMAT as typeof FORMAT,
					revision: row.revision,
					digest: hash,
					complete: !clipped && !item.evidenceTruncated,
				},
			};
		};
		let limit = original.kind === "knowledge" ? 8000 : 4000;
		let count = Math.min(10, original.evidence.length);
		let result = render(limit, count);
		const fits = () =>
			byteLength(toolEnvelope("x".repeat(128), result)) <= MAX_BYTES;
		while (count > 0 && !fits()) result = render(limit, --count);
		while (!fits()) {
			limit = Math.floor(limit * 0.75);
			if (limit < 1) throw new Error("too_large");
			result = render(limit, count);
		}
		return result;
	}
	search(args: SearchArgs) {
		// Mechanical lexical retrieval only. Fit, conflicts and composition remain LLM decisions.
		const tokens = [
			...new Intl.Segmenter("ja", { granularity: "word" }).segment(
				args.query.normalize("NFKC"),
			),
		]
			.filter((t) => t.isWordLike)
			.map((t) => t.segment)
			.filter((t) => [...t].length >= 2)
			.slice(0, 24);
		const terms = [...new Set(tokens)];
		const long = terms.filter((t) => [...t].length >= 3);
		const short = terms.filter((t) => [...t].length === 2);
		const ftsQuery = long
			.map((t) => `"${t.replaceAll('"', '""')}"`)
			.join(" OR ");
		const params: (string | number)[] = [...args.kinds, ...args.spaces];
		const filters = [
			`kind IN (${args.kinds.map(() => "?").join(",")})`,
			`space IN (${args.spaces.map(() => "?").join(",")})`,
			searchable,
		];
		if (args.types !== undefined) {
			filters.push(
				args.types.length
					? `(kind='episode' OR type IN (${args.types.map(() => "?").join(",")}))`
					: "kind='episode'",
			);
			params.push(...args.types);
		}
		const baseFilters = [...filters];
		const baseParams = [...params];
		const matches: string[] = [];
		if (long.length) {
			matches.push(
				"items.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)",
			);
			params.push(ftsQuery);
		}
		for (const term of short) {
			matches.push(
				"(instr(lower(title),lower(?))>0 OR instr(lower(search_text),lower(?))>0)",
			);
			params.push(term, term);
		}
		if (matches.length) filters.push(`(${matches.join(" OR ")})`);
		else filters.push("0"); // No wildcard scan for empty/one-character input.
		// Title pin (both profiles): items whose normalized title equals the query, under the
		// same kind/space/type/searchable filters, go first (handle tiebreak); no duplicates.
		const key = titleKey(args.query);
		const pinned = key
			? this.db
					.query<Row & { title: string }, (string | number)[]>(
						`SELECT handle,revision,document_json,title FROM items WHERE title_key=? AND ${baseFilters.join(" AND ")} ORDER BY handle LIMIT ?`,
					)
					.all(key, ...baseParams, args.limit)
			: [];
		// Keep the match universe identical; only the profile changes order.
		// Materialize scores in the FTS MATCH context (FTS5 auxiliary function requirement).
		const ranked = this.searchProfile === "bm25" && long.length > 0;
		const prefix = ranked
			? "WITH scores AS MATERIALIZED (SELECT rowid AS item_rowid, bm25(items_fts) AS score FROM items_fts WHERE items_fts MATCH ?) "
			: "";
		const join = ranked
			? " LEFT JOIN scores ON scores.item_rowid=items.rowid"
			: "";
		const order = ranked
			? "scores.score IS NULL, scores.score ASC, handle"
			: "handle";
		if (ranked) params.unshift(ftsQuery);
		params.push(args.limit + pinned.length);
		const pinnedHandles = new Set(pinned.map((r) => r.handle));
		const rows = [
			...pinned,
			...this.db
				.query<Row, (string | number)[]>(
					`${prefix}SELECT handle,revision,document_json FROM items${join} WHERE ${filters.join(" AND ")} ORDER BY ${order} LIMIT ?`,
				)
				.all(...params)
				.filter((r) => !pinnedHandles.has(r.handle)),
		].slice(0, args.limit);
		const results = rows.map((row, index) => {
			const d = this.document(row),
				item = d.item;
			return {
				handle: row.handle,
				kind: item.kind,
				type: item.kind === "knowledge" ? item.type : null,
				polarity: item.kind === "knowledge" ? item.polarity : null,
				title: cut(item.title, 512),
				summary: cut(
					item.situation ||
						(item.kind === "knowledge" ? item.body : item.lesson),
					320,
				),
				status: item.status,
				space: item.space,
				confidence: item.confidence,
				themes: [],
				evidenceSummary: {
					count: item.evidence.length,
					sourceKinds: [
						...new Set(item.evidence.map((e) => e.sourceKind)),
					].sort(),
				},
				route: [{ via: "seed", lane: "mock_lexical", rank: index + 1 }],
				score: 1 / (index + 1),
				_fixture: d._fixture,
			};
		});
		const shown = new Set(results.map((r) => r.handle));
		const warnings = this.db
			.query<{ a: string; b: string }, []>(
				"SELECT a,b FROM conflicts ORDER BY a,b",
			)
			.all()
			.filter((p) => shown.has(p.a) && shown.has(p.b))
			.map((p) => ({ kind: "unresolved_conflict", handles: [p.a, p.b] }));
		return {
			contractVersion: "contextstill-search.v1" as const,
			trust: TRUST,
			results,
			warnings,
			degraded: [
				"mock_lexical_only",
				"vector_unavailable",
				"source_details_omitted",
				...(args.theme !== undefined ? ["theme_unavailable"] : []),
				...(args.depth > 0 ? ["expansion_unavailable"] : []),
			],
			truncated: false,
		};
	}
}
