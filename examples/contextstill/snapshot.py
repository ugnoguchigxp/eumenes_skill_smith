"""Read-only, transaction-consistent PUBLIC projection. Never copies credentials or raw logs."""
import argparse
import collections
from contextlib import closing
import datetime
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile

FORMAT = "skillsmith-contextstill-fixture.v1"
ROOT = Path(__file__).resolve().parents[2]
VISIBLE = "scope='global' AND space IN ('coding','general','eumenes') AND status!='retracted' AND (retrieval='searchable' OR status='superseded')"
KN = "id,handle,layer,type,polarity,title,situation,body,rationale,exceptions_json,examples_json,applies_when_json,not_applies_when_json,steps_json,confidence,importance,status,space,scope,retrieval,revision,created_at,updated_at"
EP = "id,handle,title,situation,intent,decision,observations,action,outcome,lesson,open_questions_json,outcome_kind,event_start,event_end,time_precision,confidence,importance,status,space,scope,retrieval,revision,created_at,updated_at"


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def project(source, dest):
    """Only the named public columns and relationships are read. Source must be read-only."""
    source.execute("BEGIN")  # Pins one snapshot including any committed WAL pages.
    knowledge = [dict(r) for r in source.execute(f"SELECT {KN} FROM knowledge_items WHERE {VISIBLE} ORDER BY handle")]
    episodes = [dict(r) for r in source.execute(f"SELECT {EP} FROM episodes WHERE {VISIBLE} ORDER BY handle")]
    kn_by_id = {r["id"]: r for r in knowledge}
    ep_by_id = {r["id"]: r for r in episodes}
    links = collections.defaultdict(list)
    for row in source.execute("SELECT knowledge_id,target_kind,target_id,external_ref,role FROM knowledge_evidence ORDER BY created_at,id"):
        links[row["knowledge_id"]].append(dict(row))
    episode_links = collections.defaultdict(list)
    for row in source.execute("SELECT episode_id,source_id,role FROM episode_sources ORDER BY episode_id,source_id"):
        episode_links[row["episode_id"]].append(dict(row))

    def evidence_refs(item_id, kind):
        out, seen = [], set()

        def add(target, target_id, role, external=None):
            key = (target, external if target == "external" else target_id)
            if key in seen:
                return
            seen.add(key)
            if target == "external":
                out.append({"role": role, "sourceKind": "external"})
                return
            if target == "fragment":
                row = source.execute("SELECT source_id FROM source_fragments WHERE id=?", (target_id,)).fetchone()
                if row is None:
                    return
                target_id = row[0]
            row = source.execute("SELECT kind FROM source_records WHERE id=?", (target_id,)).fetchone()
            if row is not None:
                # Deliberately omit even publicly readable source excerpts/URLs in this fixture.
                out.append({"role": role, "sourceKind": row[0]})

        def collect(item_id, follow):
            for link in links[item_id]:
                if link["target_kind"] == "atom" and follow:
                    collect(link["target_id"], False)
                elif link["target_kind"] in ("external", "source", "fragment"):
                    add(link["target_kind"], link["target_id"], link["role"], link["external_ref"])

        if kind == "knowledge":
            collect(item_id, True)
        else:
            for link in episode_links[item_id]:
                add("source", link["source_id"], link["role"])
        return out

    successors = collections.defaultdict(list)
    for row in source.execute("SELECT src_id,dst_id FROM map_edges WHERE relation='supersedes' AND status='active' AND src_kind='knowledge' AND dst_kind='knowledge' ORDER BY id"):
        successors[row["dst_id"]].append(row["src_id"])
    for parent, rows in links.items():
        target = kn_by_id.get(parent)
        if target and target["layer"] == "canonical" and target["status"] == "active":
            for row in rows:
                if row["target_kind"] == "atom" and row["role"] == "derived_from":
                    successors[row["target_id"]].append(parent)

    def common(row, kind):
        evidence = evidence_refs(row["id"], kind)
        return {
            "handle": row["handle"], "kind": kind, "title": row["title"],
            "situation": row["situation"], "confidence": row["confidence"],
            "importance": row["importance"], "status": row["status"], "space": row["space"],
            "createdAt": row["created_at"], "updatedAt": row["updated_at"],
            "evidence": evidence[:10], "evidenceTruncated": len(evidence) > 10,
        }

    dest.executescript(Path(__file__).with_name("schema.sql").read_text())
    counts = collections.Counter()
    for kind, rows in (("knowledge", knowledge), ("episode", episodes)):
        for row in rows:
            item = common(row, kind)
            if kind == "knowledge":
                item.update({key: row[key] for key in ("layer", "type", "polarity", "body", "rationale")})
                for public, column in (("exceptions", "exceptions_json"), ("appliesWhen", "applies_when_json"), ("notAppliesWhen", "not_applies_when_json"), ("steps", "steps_json")):
                    item[public] = json.loads(row[column])
                item["examples"] = []
                for example in json.loads(row["examples_json"]):
                    handles = [ep_by_id[e]["handle"] for e in example.get("episodeIds", []) if e in ep_by_id and ep_by_id[e]["status"] == "active"]
                    if handles:
                        item["examples"].append({key: example[key] for key in ("situation", "action", "outcome")} | {"episodes": handles})
                item["supportCount"] = len({e["target_id"] for e in links[row["id"]] if e["target_kind"] == "atom" and e["role"] != "refutes"})
                item["supersededBy"] = next((kn_by_id[i]["handle"] for i in successors[row["id"]] if i in kn_by_id and kn_by_id[i]["status"] == "active" and kn_by_id[i]["layer"] == "canonical"), None) if row["status"] == "superseded" else None
                search_text = "\n".join([row["situation"], row["body"], row["rationale"]] + item["appliesWhen"] + item["notAppliesWhen"] + item["steps"])
            else:
                item.update({key: row[key] for key in ("intent", "decision", "observations", "action", "outcome", "lesson")})
                for public, column in (("openQuestions", "open_questions_json"),):
                    item[public] = json.loads(row[column])
                for public, column in (("outcomeKind", "outcome_kind"), ("eventStart", "event_start"), ("eventEnd", "event_end"), ("timePrecision", "time_precision")):
                    item[public] = row[column]
                search_text = "\n".join(row[k] for k in ("situation", "intent", "decision", "observations", "action", "outcome", "lesson"))
            dest.execute("INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (row["handle"], kind, row.get("type"), row["space"], row["scope"], row["status"], row["retrieval"], row.get("layer"), row["revision"], row["title"], search_text, encode(item)))
            counts[kind] += 1
    # The named columns contain no judgment detail or model traces.
    for row in source.execute("SELECT a_id,b_id FROM distill_pair_judgments WHERE verdict IN ('conflict','unknown') AND resolution NOT IN ('a_wins','b_wins','owner_resolved')"):
        a, b = kn_by_id.get(row["a_id"]), kn_by_id.get(row["b_id"])
        if a and b and all(r["status"] == "active" and r["layer"] == "canonical" for r in (a, b)):
            dest.execute("INSERT OR IGNORE INTO conflicts VALUES(?,?)", (a["handle"], b["handle"]))
    dest.execute("INSERT INTO items_fts(items_fts) VALUES('rebuild')")
    metadata = {
        "format": FORMAT, "snapshotAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "counts": dict(counts), "projection": "global/non-personal public items; evidence role/kind only",
        "omitted": ["credentials", "settings", "raw_sources", "source_excerpts", "source_urls", "vectors", "personal", "repo_scope", "themes", "logs"],
    }
    for key, value in metadata.items():
        dest.execute("INSERT INTO fixture_metadata VALUES(?,?)", (key, encode(value)))
    dest.commit()
    if dest.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise RuntimeError("snapshot_integrity_failed")
    source.rollback()
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT.parent / "contextStill/data/context-still.sqlite3")
    parser.add_argument("--dest", type=Path, default=ROOT / "data/contextstill/snapshot.sqlite")
    parser.add_argument("--replace", action="store_true")
    args = parser.parse_args()
    source_path, target = args.source.resolve(strict=True), args.dest.resolve()
    if source_path == target:
        parser.error("source_and_destination_must_differ")
    if target.exists() and not args.replace:
        parser.error("destination_exists_use_replace")
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=".snapshot-", dir=target.parent)
    os.close(descriptor)  # mkstemp creates mode 0600, including while building.
    try:
        with closing(sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True)) as source, closing(sqlite3.connect(temporary)) as dest:
            source.row_factory = sqlite3.Row
            source.execute("PRAGMA query_only=ON")
            metadata = project(source, dest)
            commit = subprocess.run(["git", "-C", str(source_path.parent.parent), "rev-parse", "HEAD"], capture_output=True, text=True)
            if commit.returncode == 0:
                dest.execute("INSERT INTO fixture_metadata VALUES('sourceCommit',?)", (encode(commit.stdout.strip()),))
                dest.commit()
        if args.replace:
            os.replace(temporary, target)
        else:
            os.link(temporary, target)  # Atomic no-clobber even if a second exporter races.
            os.unlink(temporary)
        print(encode({"format": FORMAT, "counts": metadata["counts"], "bytes": target.stat().st_size}))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    main()
