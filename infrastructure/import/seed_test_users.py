#!/usr/bin/env python3
"""seed_test_users.py -- curated test users for UI/perf validation.

Real auth (SAML/OAuth) comes later; until then we seed a handful of named users
into the LOCAL plane (app_user + group_membership), each mapped to a real
imported group spanning the scope spectrum (broadest -> narrow), so the dev
login can impersonate them and we can validate the list at different scales.

Bridges both planes: reads group_ids from GLOBAL, writes users/memberships to
LOCAL. Uses IMPORT_GLOBAL_DSN / IMPORT_LOCAL_DSN (same as load.py).

Run:  python seed_test_users.py
"""

from __future__ import annotations
import os, psycopg

g = psycopg.connect(os.environ["IMPORT_GLOBAL_DSN"])
l = psycopg.connect(os.environ["IMPORT_LOCAL_DSN"])

# Groups by grant count (skip per-user singleton groups).
with g.cursor() as c:
    c.execute("""
        SELECT pg.group_id, pg.label, count(*) AS grants
        FROM authz_grant ag JOIN principal_group pg ON pg.group_id = ag.group_id
        WHERE pg.label NOT LIKE 'user:%' AND pg.label <> ''
        GROUP BY 1,2 ORDER BY grants DESC
    """)
    ranked = c.fetchall()

if not ranked:
    raise SystemExit("no groups found -- run load.py first")

def by_label(lbl):
    for gid, l2, n in ranked:
        if l2 == lbl:
            return gid, l2, n
    return None

broadest = ranked[0]
median   = ranked[len(ranked)//2]
narrow   = ranked[-1]
picks = [broadest, median, narrow]
for lbl in ("RSC", "BU_MR", "Helpdesk RoW"):
    p = by_label(lbl)
    if p and p not in picks:
        picks.append(p)

# Fixed UUIDs so logins are stable across re-seeds.
TEST = [
    ("dddd0000-0000-0000-0000-000000000001", "Tess", "Broadest"),
    ("dddd0000-0000-0000-0000-000000000002", "Mia",  "Median"),
    ("dddd0000-0000-0000-0000-000000000003", "Nora", "Narrow"),
    ("dddd0000-0000-0000-0000-000000000004", "Rick", "RSC"),
    ("dddd0000-0000-0000-0000-000000000005", "Bev",  "BUMR"),
    ("dddd0000-0000-0000-0000-000000000006", "Hank", "Helpdesk"),
]

rows = []
for (uid, fn, tag), (gid, label, n) in zip(TEST, picks):
    email = f"{fn.lower()}.{tag.lower()}@test.local"
    rows.append((uid, fn, tag, email, gid, label, n))

with l.cursor() as c:
    for uid, fn, tag, email, gid, label, n in rows:
        c.execute("""
            INSERT INTO app_user (user_id, home_region, firstname, lastname, email)
            VALUES (%s, 'eu-west-2', %s, %s, %s)
            ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email
        """, (uid, fn, tag, email))
        c.execute("""
            INSERT INTO group_membership (group_id, user_id)
            VALUES (%s, %s) ON CONFLICT (group_id, user_id) DO NOTHING
        """, (gid, uid))
    l.commit()

print("Seeded test users (email -> group[grants]):")
for uid, fn, tag, email, gid, label, n in rows:
    print(f"  {email:32s} -> {label} [{n} grants]")

g.close(); l.close()
