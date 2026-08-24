# ITPipes observation code dictionary

`itpipes_observation_code.sql` seeds the dictionary that backs the add-defect form on the
Proactive Team CCTV review page. It is data, not schema, so it needs no Alembic migration
and no change through the Portal Workstation schema tool.

Apply it once to the authoritative `system.db`:

```powershell
sqlite3 "path\to\config\system.db" ".read itpipes_observation_code.sql"
```

The statements are `INSERT OR IGNORE`, so re-running only adds codes that are missing and
never overwrites an edit made through the Dictionary admin screen.

## Why the labels matter

The STM Risk ETL branches on these exact strings. `scoring.py` routes clogging on
`Code.startswith(("L", "M"))` and excludes rows whose `Observation_Text` starts with
`Access` or `Vermin`. Rewording a label therefore changes how an asset scores. Treat the
labels as canonical ITPipes text rather than display copy.

## metadata_json

Each item records which inputs the code actually uses, measured from the ITPipes mirror
rather than assumed. A field is marked applicable when it is populated on at least 5% of
that code's real observations:

```json
{"clock":true,"continuous":true,"grade":true,"joint":false,
 "remarks":false,"source_rows":3550,"value_percent":true}
```

The add-defect form shows only the applicable inputs, which matters because roughly a
third of real ITPipes observations legitimately have no grade — access points and water
level readings are observations, not graded defects, and forcing a grade would invent
data.

`source_rows` is the evidence behind the flags, and lets rarely used codes be deactivated
through `is_active` rather than deleted.

## Regenerating

`build_itpipes_observation_code.py` rebuilds the file from the ITPipes mirror when new
codes appear. Update `SRC` to the current mirror version before running it.
