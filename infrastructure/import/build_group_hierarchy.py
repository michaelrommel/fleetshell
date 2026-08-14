#!/usr/bin/env python3
"""build_group_hierarchy.py -- materialize the full group tree in principal_group.

Builds the org tree from old_database/groups.txt (a tab-indented tree) plus the
strict BU_/CCC_/CountryAdmin_/..._ naming, and sets principal_group.path
(id-based ltree) + parent_id, so grant inheritance goes live
(grant.group.path @> user.group.path -- see docs/mdm_design.md) AND the Groups
tab can render the real hierarchy.

Parent per label:
  1. explicit parent from groups.txt (nearest line with fewer tabs),
  2. else longest '_'-prefix that is a known node (strict naming),
  3. else a manual override (below),
  4. else it is a root.

FULL tree: structural nodes that appear in groups.txt but carry no grants (so
load.py never created them, e.g. All / CCC / CCC_DE / Support / Partner) are
MATERIALIZED here as grant-less, member-less principal_group rows, so the tree
is complete and paths/parent_id chain through them. Grant-less nodes add nothing
to inheritance; they only provide structure.

Per-user groups (label 'user:<id>') are left untouched (legacy Single User
Grants; excluded from the tree).

Run (reads groups.txt next to this script, writes to the GLOBAL plane):
    IMPORT_GLOBAL_DSN="host=... dbname=fleetshell ..." python build_group_hierarchy.py         # dry-run
    ... python build_group_hierarchy.py --apply    # create structural nodes + write path/parent

Idempotent; re-run safe (structural nodes are matched by label, not recreated).
"""
from __future__ import annotations
import os, sys, uuid, psycopg

HERE = os.path.dirname(os.path.abspath(__file__))
GROUPS_TXT = os.path.join(HERE, "old_database", "groups.txt")

# Nodes the file/naming cannot place (owner-provided). Parent must be a known label.
MANUAL_PARENT = {
    "Speciale gebruikers": "CCC_NL",
    "FRA MRI engineers for Medispace": "CCC_NL",
}


def parse_file_tree(path: str) -> dict[str, str | None]:
    """label -> parent label, where parent = nearest previous line with fewer tabs."""
    parent: dict[str, str | None] = {}
    stack: list[tuple[int, str]] = []
    with open(path) as f:
        for ln in f:
            if not ln.strip():
                continue
            tabs = len(ln) - len(ln.lstrip("\t"))
            label = ln.strip()
            while stack and stack[-1][0] >= tabs:
                stack.pop()
            parent[label] = stack[-1][1] if stack else None
            stack.append((tabs, label))
    return parent


def main() -> None:
    apply = "--apply" in sys.argv
    file_parent = parse_file_tree(GROUPS_TXT)
    fileset = set(file_parent)

    conn = psycopg.connect(os.environ["IMPORT_GLOBAL_DSN"])
    with conn.cursor() as c:
        c.execute("SELECT group_id, label FROM principal_group WHERE label <> '' AND label NOT LIKE 'user:%'")
        rows = c.fetchall()
    label_id: dict[str, str] = {label: str(gid) for gid, label in rows}
    db_existing = set(label_id)

    # Full node universe = every groups.txt label + every real (grant-bearing) group.
    all_labels = fileset | db_existing

    def name_parent(g: str) -> str | None:
        p = g
        while "_" in p:
            p = p.rsplit("_", 1)[0]
            if p in all_labels:
                return p
        return None

    def parent_label(g: str) -> str | None:
        if g in MANUAL_PARENT:
            return MANUAL_PARENT[g]
        if g in file_parent:
            return file_parent[g]
        return name_parent(g)

    # Materialize structural nodes (in the file/naming, no grants -> not yet a row).
    new_rows: list[tuple[str, str]] = []
    for lbl in all_labels:
        if lbl not in label_id:
            gid = str(uuid.uuid4())
            label_id[lbl] = gid
            new_rows.append((gid, lbl))

    def seg(lbl: str) -> str:
        return "g" + label_id[lbl].replace("-", "")

    def chain(lbl: str) -> list[str]:
        """[root ... lbl] over the FULL tree (structural nodes included)."""
        out: list[str] = []
        cur: str | None = lbl
        seen: set[str] = set()
        while cur is not None and cur not in seen:
            seen.add(cur)
            out.append(cur)
            cur = parent_label(cur)
        return list(reversed(out))

    updates: list[tuple[str, str, str | None]] = []   # (group_id, path, parent_id)
    roots = 0
    for lbl in all_labels:
        ch = chain(lbl)
        path = ".".join(seg(x) for x in ch)
        parent_id = label_id[ch[-2]] if len(ch) >= 2 else None
        if parent_id is None:
            roots += 1
        updates.append((label_id[lbl], path, parent_id))

    print(f"nodes: {len(all_labels)}  (existing {len(db_existing)}, new structural {len(new_rows)})")
    print(f"  roots: {roots}")

    if not apply:
        print("dry-run -- pass --apply to create structural nodes + write path + parent_id.")
        conn.close()
        return

    with conn.cursor() as c:
        if new_rows:
            # Insert structural nodes first so parent_id FKs resolve.
            c.executemany(
                "INSERT INTO principal_group (group_id, home_region, label) VALUES (%s, 'eu-west-2', %s) "
                "ON CONFLICT (group_id) DO NOTHING",
                new_rows,
            )
        c.executemany(
            "UPDATE principal_group SET path = %s::ltree, parent_id = %s WHERE group_id = %s",
            [(path, pid, gid) for (gid, path, pid) in updates],
        )
    conn.commit()
    conn.close()
    print(f"applied: {len(new_rows)} structural nodes created, {len(updates)} groups linked.")


if __name__ == "__main__":
    main()
