"""Generate the itpipes_observation_code dictionary seed from the real ITpipes mirror.

Labels are the canonical Observation_Text for each code (the most frequently used
variant). metadata_json records which inputs a code actually uses, measured from the
source data rather than guessed, so the add-defect form can show only relevant fields.
"""
import json
from pathlib import Path

import duckdb

SRC = (r"C:\Users\105692\AppData\Local\StormWaterPortal\data\source-cache\versions"
       r"\mirror.itpipes\20260819T040613Z-cff31913\itpipes_stormwater_prod.duckdb")
OUT = Path(__file__).with_name("seed_itpipes_observation_code.sql")

# A field is offered on the form when it is populated for a meaningful share of the
# code's real observations. Below this it is treated as incidental data entry.
APPLICABLE_SHARE = 0.05

con = duckdb.connect()
con.execute(f"ATTACH '{SRC}' AS s (READ_ONLY)")

rows = con.execute("""
    WITH labelled AS (
        SELECT Code, Observation_Text, count(*) AS text_rows,
               row_number() OVER (PARTITION BY Code ORDER BY count(*) DESC, Observation_Text) AS rn
        FROM s.MLO
        WHERE Code IS NOT NULL AND trim(Code) <> ''
        GROUP BY Code, Observation_Text
    ),
    stats AS (
        SELECT Code,
               count(*) AS total,
               count(Grade) AS grade_rows,
               count(Value_Percent) AS percent_rows,
               count(Clock_From) + count(Clock_To) AS clock_rows,
               count(*) FILTER (WHERE Joint) AS joint_rows,
               count(*) FILTER (WHERE Continuous IS NOT NULL AND trim(Continuous) <> '') AS continuous_rows,
               count(Remarks) AS remarks_rows
        FROM s.MLO
        WHERE Code IS NOT NULL AND trim(Code) <> ''
        GROUP BY Code
    )
    SELECT l.Code, l.Observation_Text, s.total, s.grade_rows, s.percent_rows,
           s.clock_rows, s.joint_rows, s.continuous_rows, s.remarks_rows,
           (SELECT count(*) FROM labelled x WHERE x.Code = l.Code) AS text_variants
    FROM labelled l JOIN stats s ON s.Code = l.Code
    WHERE l.rn = 1
    ORDER BY s.total DESC, l.Code
""").fetchall()
con.close()


def sql_text(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


lines = [
    "-- itpipes_observation_code dictionary seed",
    "-- Generated from the ITpipes mirror. Labels are canonical ITpipes observation text:",
    "-- the STM Risk scoring routes branch on Code and Observation_Text prefixes, so these",
    "-- values must not be reworded casually.",
    "-- Idempotent: re-running inserts only codes that are missing.",
    "",
    "INSERT OR IGNORE INTO SYS_DICTIONARIES (",
    "    dictionary_key, name, description, is_active, created_at, updated_at",
    ") VALUES (",
    "    'itpipes_observation_code',",
    "    'ITPipes Observation Codes',",
    "    'PACP observation codes and canonical text for reviewer-added defects.',",
    "    1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP",
    ");",
    "",
]

summary = []
for order, r in enumerate(rows, start=1):
    (code, label, total, grade_rows, percent_rows, clock_rows,
     joint_rows, continuous_rows, remarks_rows, variants) = r
    meta = {
        "grade": grade_rows / total >= APPLICABLE_SHARE,
        "value_percent": percent_rows / total >= APPLICABLE_SHARE,
        "clock": clock_rows / total >= APPLICABLE_SHARE,
        "joint": joint_rows / total >= APPLICABLE_SHARE,
        "continuous": continuous_rows / total >= APPLICABLE_SHARE,
        "remarks": remarks_rows / total >= APPLICABLE_SHARE,
        "source_rows": int(total),
    }
    summary.append((code, label, meta, variants, total))
    lines.append(
        "INSERT OR IGNORE INTO SYS_DICTIONARY_ITEMS ("
        "dictionary_id, item_code, label, sort_order, is_active, metadata_json, created_at, updated_at) "
        "SELECT id, {code}, {label}, {order}, 1, {meta}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP "
        "FROM SYS_DICTIONARIES WHERE dictionary_key = 'itpipes_observation_code';".format(
            code=sql_text(code),
            label=sql_text(label),
            order=order,
            meta=sql_text(json.dumps(meta, separators=(",", ":"), sort_keys=True)),
        )
    )

OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")

print(f"codes: {len(rows)}  ->  {OUT}")
print(f"codes with >1 text variant: {sum(1 for s in summary if s[3] > 1)}")
print("\nfields offered, by code count:")
for field in ("grade", "value_percent", "clock", "joint", "continuous", "remarks"):
    print(f"  {field:<14} {sum(1 for s in summary if s[2][field])}")
print("\ntop 12 codes by usage:")
for code, label, meta, _v, total in summary[:12]:
    on = ",".join(k for k in ("grade", "value_percent", "continuous") if meta[k]) or "-"
    print(f"  {code:<7} {label[:44]:<46} rows={total:<6} {on}")
