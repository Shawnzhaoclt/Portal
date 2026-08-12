#!/usr/bin/env python
"""Export one ArcGIS-readable spatial layer to a temporary Parquet file."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def export_layer(
    connection: Path,
    dataset: str,
    fields: list[str],
    output: Path,
) -> dict[str, object]:
    try:
        import arcpy
        import pandas as pd
    except ImportError as exc:
        raise RuntimeError("This helper must run with the configured ArcGIS Pro Python environment.") from exc

    source = str(connection / dataset)
    if not arcpy.Exists(source):
        raise RuntimeError(f"ArcGIS source layer was not found: {source}")
    description = arcpy.Describe(source)
    geometry_field = str(getattr(description, "shapeFieldName", "") or "")
    spatial_reference = getattr(description, "spatialReference", None)
    source_srid = int(getattr(spatial_reference, "factoryCode", 0) or 0)
    if not geometry_field or source_srid <= 0:
        raise RuntimeError(f"ArcGIS source has no usable geometry or spatial reference: {source}")

    output.parent.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, object]] = []
    cursor_fields = [*fields, "SHAPE@WKB"]
    with arcpy.da.SearchCursor(source, cursor_fields) as rows:
        for row in rows:
            record = {field: row[index] for index, field in enumerate(fields)}
            geometry = row[-1]
            record["__geometry_wkb"] = bytes(geometry) if geometry else None
            record["__geometry_srid"] = source_srid
            records.append(record)
    if not records:
        raise RuntimeError(f"ArcGIS source contains no records: {source}")

    dataframe = pd.DataFrame.from_records(records)
    dataframe.to_parquet(output, index=False)
    return {
        "source": source,
        "output": str(output),
        "rows": len(dataframe),
        "sourceSrid": source_srid,
        "geometryColumn": geometry_field,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connection", type=Path, required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--field", action="append", default=[])
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        result = export_layer(
            connection=arguments.connection,
            dataset=str(arguments.dataset),
            fields=[str(field) for field in arguments.field],
            output=arguments.output,
        )
    except Exception as exc:
        print(str(exc))
        return 1
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
