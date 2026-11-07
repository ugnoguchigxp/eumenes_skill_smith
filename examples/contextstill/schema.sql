CREATE TABLE fixture_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE items(
 handle TEXT PRIMARY KEY, kind TEXT NOT NULL, type TEXT,
 space TEXT NOT NULL CHECK(space IN ('coding','general','eumenes')),
 scope TEXT NOT NULL CHECK(scope='global'), status TEXT NOT NULL CHECK(status!='retracted'),
 retrieval TEXT NOT NULL, layer TEXT, revision INTEGER NOT NULL,
 title TEXT NOT NULL, search_text TEXT NOT NULL, document_json TEXT NOT NULL CHECK(json_valid(document_json)), title_key TEXT NOT NULL
) STRICT;
CREATE INDEX items_title_key ON items(title_key,handle);
CREATE VIRTUAL TABLE items_fts USING fts5(title,search_text,content='items',content_rowid='rowid',tokenize='trigram');
CREATE TABLE conflicts(a TEXT NOT NULL REFERENCES items(handle),b TEXT NOT NULL REFERENCES items(handle),PRIMARY KEY(a,b)) STRICT;
