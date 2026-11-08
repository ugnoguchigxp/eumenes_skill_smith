/** Mechanical lexical retrieval, matching the existing ContextStill fixture approach.
 * Ranking only supplies candidates; it never makes an applicability or permission decision.
 */
export function approvedSearchQuery(query: string | undefined): string | null {
	if (!query) return null;
	const terms = [
		...new Set(
			[
				...new Intl.Segmenter("ja", { granularity: "word" }).segment(
					query.normalize("NFKC"),
				),
			]
				.filter((t) => t.isWordLike && [...t.segment].length >= 3)
				.map((t) => t.segment)
				.slice(0, 24),
		),
	];
	return terms.length
		? terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ")
		: null;
}
const metadata = (column: string) =>
	`CASE WHEN json_valid(${column}) THEN coalesce(json_extract(${column},'$.artifact.name'),'')||' '||coalesce(json_extract(${column},'$.applicability'),'')||' '||coalesce(json_extract(${column},'$.template.content.task.goal'),'') ELSE '' END`;
export const approvedSearchMigration = `
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_approved_search USING fts5(metadata, tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS knowledge_approved_search_insert AFTER INSERT ON knowledge_approved_skills BEGIN
 INSERT INTO knowledge_approved_search(rowid,metadata) VALUES(new.rowid,${metadata("new.data_json")});
END;
CREATE TRIGGER IF NOT EXISTS knowledge_approved_search_delete AFTER DELETE ON knowledge_approved_skills BEGIN
 DELETE FROM knowledge_approved_search WHERE rowid=old.rowid;
END;
CREATE TRIGGER IF NOT EXISTS knowledge_approved_search_update AFTER UPDATE ON knowledge_approved_skills BEGIN
 DELETE FROM knowledge_approved_search WHERE rowid=old.rowid;
 INSERT INTO knowledge_approved_search(rowid,metadata) VALUES(new.rowid,${metadata("new.data_json")});
END;
INSERT INTO knowledge_approved_search(rowid,metadata)
 SELECT rowid,${metadata("data_json")} FROM knowledge_approved_skills
 WHERE NOT EXISTS(SELECT 1 FROM knowledge_approved_search WHERE knowledge_approved_search.rowid=knowledge_approved_skills.rowid);
`;
