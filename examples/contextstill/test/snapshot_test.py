import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "snapshot.py"
spec = importlib.util.spec_from_file_location("snapshot", SCRIPT)
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="skillsmith-export-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.path = self.root / "source.sqlite"
        self.source = sqlite3.connect(self.path)
        self.addCleanup(self.source.close)
        self.source.execute("PRAGMA journal_mode=WAL")
        for table, columns in (("knowledge_items", snapshot.KN), ("episodes", snapshot.EP)):
            self.source.execute(f"CREATE TABLE {table}({','.join(c + ' TEXT' for c in columns.split(','))})")
        self.source.executescript("""
          CREATE TABLE settings_credentials(secret TEXT);
          INSERT INTO settings_credentials VALUES('MUST_NOT_BE_COPIED');
          CREATE TABLE knowledge_evidence(id TEXT,knowledge_id TEXT,target_kind TEXT,target_id TEXT,external_ref TEXT,role TEXT,created_at TEXT);
          CREATE TABLE episode_sources(episode_id TEXT,source_id TEXT,role TEXT);
          CREATE TABLE source_records(id TEXT,kind TEXT,content TEXT);
          INSERT INTO source_records VALUES('log','agent_log','PRIVATE_LOG_MUST_NOT_BE_COPIED');
          CREATE TABLE source_fragments(id TEXT,source_id TEXT);
          CREATE TABLE map_edges(id TEXT,src_id TEXT,dst_id TEXT,relation TEXT,status TEXT,src_kind TEXT,dst_kind TEXT);
          CREATE TABLE distill_pair_judgments(a_id TEXT,b_id TEXT,verdict TEXT,resolution TEXT);
        """)
        self.insert("knowledge_items", {"id": "public", "handle": "kn_" + "a" * 26, "title": "検証", "examples_json": json.dumps([
            {"situation": "public example", "action": "inspect", "outcome": "confirmed", "episodeIds": ["ep-public", "ep-private"]},
            {"situation": "PRIVATE_EXAMPLE_MUST_NOT_BE_COPIED", "action": "x", "outcome": "x", "episodeIds": ["ep-private"]},
        ])})
        for name, extra in (("private", {"space": "personal"}), ("repo", {"scope": "repo"}), ("retracted", {"status": "retracted"}), ("hidden", {"retrieval": "evidence_only"})):
            self.insert("knowledge_items", {"id": name, "handle": "kn_" + "z" * 26, "body": "PRIVATE_ROW_MUST_NOT_BE_COPIED", **extra})
        self.insert("knowledge_items", {"id": "superseded", "handle": "kn_" + "b" * 26, "status": "superseded", "retrieval": "evidence_only"})
        self.insert("episodes", {"id": "ep-public", "handle": "ep_" + "a" * 26})
        self.insert("episodes", {"id": "ep-private", "handle": "ep_" + "b" * 26, "space": "personal"})
        self.source.execute("INSERT INTO knowledge_evidence VALUES('e','public','source','log',NULL,'supports','2026-11-01')")
        self.source.commit()  # Data remains in the WAL while this connection stays open.

    def insert(self, table, override):
        columns = (snapshot.KN if table == "knowledge_items" else snapshot.EP).split(",")
        row = {c: "" for c in columns}
        for c in columns:
            if c.endswith("_json"):
                row[c] = "[]"
        row.update(scope="global", space="general", status="active", retrieval="searchable", revision=1,
                   confidence=0.9, importance=0.5, created_at="2026-11-01", updated_at="2026-11-01")
        if table == "knowledge_items":
            row.update(layer="canonical", type="procedure", polarity="positive")
        else:
            row.update(outcome_kind="unknown", time_precision="unknown", event_start=None, event_end=None)
        row.update(override)
        self.source.execute(f"INSERT INTO {table} VALUES({','.join('?' for _ in columns)})", [row[c] for c in columns])

    def test_public_projection_reads_wal_and_leaves_source_unchanged(self):
        before = self.path.read_bytes()
        dest_path = self.root / "copy.sqlite"
        result = subprocess.run([sys.executable, str(SCRIPT), "--source", str(self.path), "--dest", str(dest_path)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["counts"], {"knowledge": 2, "episode": 1})
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(dest_path.stat().st_mode & 0o777, 0o600)
        copied = sqlite3.connect(dest_path)
        self.addCleanup(copied.close)
        tables = {r[0] for r in copied.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
        self.assertNotIn("settings_credentials", tables)
        self.assertNotIn("source_records", tables)
        serialized = "\n".join(r[0] for r in copied.execute("SELECT document_json FROM items"))
        for secret in ("MUST_NOT_BE_COPIED", "PRIVATE_LOG", "PRIVATE_ROW", "PRIVATE_EXAMPLE"):
            self.assertNotIn(secret, serialized)
        document = json.loads(copied.execute("SELECT document_json FROM items WHERE handle=?", ("kn_" + "a" * 26,)).fetchone()[0])
        self.assertEqual(document["examples"][0]["episodes"], ["ep_" + "a" * 26])
        self.assertEqual(document["evidence"], [{"role": "supports", "sourceKind": "agent_log"}])
        self.assertEqual(copied.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        # Neither raw settings nor raw source text is needed to produce the projection.
        self.assertEqual(len(list(self.source.execute("SELECT * FROM settings_credentials"))), 1)

    def test_refuses_overwrite_and_source_as_destination(self):
        destination = self.root / "copy.sqlite"
        destination.write_bytes(b"existing")
        for dest in (destination, self.path):
            result = subprocess.run([sys.executable, str(SCRIPT), "--source", str(self.path), "--dest", str(dest)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
        self.assertEqual(destination.read_bytes(), b"existing")


if __name__ == "__main__":
    unittest.main()
