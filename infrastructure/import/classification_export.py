#!/usr/bin/env python3
"""
classification_export.py -- dump the current DB data-classification into the
name-keyed classification.json artifact (the round-trip of stage_classification
in load.py). Run after editing classification in the portal UI, then commit the
file so a future old_database reload restores your edits.

  IMPORT_GLOBAL_DSN=... python classification_export.py [--out classification.json]

See docs/data_classification.md.
"""
import argparse, json, os
import psycopg

HERE = os.path.dirname(os.path.abspath(__file__))
CLASS_ORDER = ["PHI", "UPD", "RD", "PII", "ACD", "DSH", "TSD", "STD"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "classification.json"))
    a = ap.parse_args()
    g = psycopg.connect(os.environ["IMPORT_GLOBAL_DSN"])

    art = {"version": 1, "modalities": {}}
    with g.cursor() as c:
        c.execute("""
            SELECT m.name AS modality, s.id, s.name, s.description
            FROM classification_set s
            JOIN product m ON m.id = s.modality_id
            ORDER BY m.name, s.name""")
        sets = c.fetchall()

        for modality, set_id, set_name, desc in sets:
            c.execute("""
                SELECT r.regex,
                       COALESCE(array_agg(rc.code) FILTER (WHERE rc.code IS NOT NULL), '{}')
                FROM classification_rule r
                LEFT JOIN classification_rule_class rc ON rc.rule_id = r.id
                WHERE r.set_id = %s
                GROUP BY r.id, r.regex, r.sort_order
                ORDER BY r.sort_order""", (set_id,))
            rules = []
            for regex, codes in c.fetchall():
                ordered = [x for x in CLASS_ORDER if x in set(codes)]
                rules.append({"regex": regex, "codes": ordered})

            c.execute("""
                SELECT a.product_id IS NULL AND a.family IS NULL AS modwide,
                       p.name AS product, a.family
                FROM classification_assignment a
                LEFT JOIN product p ON p.id = a.product_id
                WHERE a.set_id = %s""", (set_id,))
            modwide = False
            products, families = set(), set()
            for mw, product, family in c.fetchall():
                if mw:
                    modwide = True
                elif product is not None:
                    products.add(product)
                elif family is not None:
                    families.add(family)

            block = art["modalities"].setdefault(modality, {"family_based": False, "sets": []})
            if families and not products:
                block["family_based"] = True
            block["sets"].append({
                "name": set_name,
                "description": desc or "",
                "rules": rules,
                "assign": {
                    "modality_wide": modwide,
                    "products": sorted(products),
                    "families": sorted(families),
                },
            })

    with open(a.out, "w") as f:
        json.dump(art, f, indent=1, ensure_ascii=False)
        f.write("\n")
    n_sets = sum(len(b["sets"]) for b in art["modalities"].values())
    print(f"wrote {a.out}: {len(art['modalities'])} modalities, {n_sets} sets")
    g.close()


if __name__ == "__main__":
    main()
