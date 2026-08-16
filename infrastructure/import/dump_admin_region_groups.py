#!/usr/bin/env python3
"""dump_admin_region_groups.py -- seeding aid for the group-admin migration.

The legacy "administrative regions" (RDREGION.REGIONTYPE=1) are intentionally
dropped from the import (see load.py stage_reference / stage_grants). Their names
are, however, the most useful thing to salvage: an `_A_<GROUP>` node encodes the
intended admin domain for the group `<GROUP>`. This script extracts that mapping
straight from the source files (no DB access -- safe to run any time, including
during a reload) so the real group-admin relationships can be re-authored as
`resource_type='group'` subtree grants in the new portal UI.

It reads only:
  old_database/RDREGION.csv.gz   (id, name, REGIONTYPE)
  old_database/groups.txt        (the tab-indented group tree -> known labels)

and writes next to itself:
  admin_region_group_map.json    (structured; the seeding source of truth)
  admin_region_group_map.md      (human-readable review table)

Status per row:
  matched          -> `_A_`-stripped name IS a known group label in groups.txt
                      (author a group:edit/add_member grant on that group subtree)
  a_unmatched      -> `_A_`-prefixed but the stripped label is not in groups.txt
                      (likely a real principal_group not present as a structural
                       node in groups.txt; verify against the DB before seeding)
  legacy_no_group  -> not `_A_`-prefixed (_old_RSC_*, 'Administrative Region 1',
                       _old_*Support*): pure legacy scaffolding, no group -- drop.

Usage:
    python dump_admin_region_groups.py
"""
from __future__ import annotations
import csv, gzip, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "old_database")


def read_admin_regions() -> list[dict[str, str]]:
    path = os.path.join(SRC, "RDREGION.csv.gz")
    with gzip.open(path, "rt", encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f, delimiter=";"))
    return [r for r in rows if (r.get("REGIONTYPE") or "0") == "1"]


def read_group_labels() -> set[str]:
    path = os.path.join(SRC, "groups.txt")
    labels: set[str] = set()
    with open(path, encoding="utf-8") as f:
        for ln in f:
            s = ln.strip()
            if s:
                labels.add(s)
    return labels


def classify(name: str, labels: set[str]) -> tuple[str | None, str]:
    """Return (candidate_group_label, status)."""
    if name.startswith("_A_"):
        cand = name[3:]
        return (cand, "matched" if cand in labels else "a_unmatched")
    return (None, "legacy_no_group")


def main() -> None:
    admin = read_admin_regions()
    labels = read_group_labels()

    entries = []
    for r in sorted(admin, key=lambda r: r["NAME"]):
        cand, status = classify(r["NAME"], labels)
        entries.append({
            "region_id": r["ID"],
            "region_name": r["NAME"],
            "candidate_group": cand,
            "status": status,
        })

    counts: dict[str, int] = {}
    for e in entries:
        counts[e["status"]] = counts.get(e["status"], 0) + 1

    json_path = os.path.join(HERE, "admin_region_group_map.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({"counts": counts, "entries": entries}, f, indent=2, ensure_ascii=False)

    md_path = os.path.join(HERE, "admin_region_group_map.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("# Administrative-region -> group seeding map\n\n")
        f.write(f"Source: `old_database/RDREGION.csv.gz` (REGIONTYPE=1) + "
                f"`old_database/groups.txt`. {len(entries)} administrative regions.\n\n")
        f.write("| Status | Count |\n|---|---|\n")
        for k in ("matched", "a_unmatched", "legacy_no_group"):
            if k in counts:
                f.write(f"| {k} | {counts[k]} |\n")
        f.write("\n| Region name | Candidate group | Status |\n|---|---|---|\n")
        for e in entries:
            f.write(f"| `{e['region_name']}` | "
                    f"{('`'+e['candidate_group']+'`') if e['candidate_group'] else '-'} | "
                    f"{e['status']} |\n")

    print(f"admin regions: {len(entries)}")
    for k in ("matched", "a_unmatched", "legacy_no_group"):
        print(f"  {k}: {counts.get(k, 0)}")
    print(f"wrote {os.path.relpath(json_path, HERE)} + {os.path.relpath(md_path, HERE)}")


if __name__ == "__main__":
    main()
