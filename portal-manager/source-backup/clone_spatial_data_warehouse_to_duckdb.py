#!/usr/bin/env python
"""Rebuild the dedicated Spatial Data Warehouse DuckDB mirror."""

from __future__ import annotations

import argparse
from pathlib import Path

from clone_sqlserver_to_duckdb import (
    CloneItem,
    SqlDatabase,
    _load_config,
    run_clone,
    print_manifest,
    write_manifest_csv,
)


SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPT_DIR / "clone_spatial_data_warehouse_to_duckdb.json"
CONFIG = _load_config(CONFIG_PATH)
DATABASES = {
    key: SqlDatabase(key=key, **values)
    for key, values in CONFIG["databases"].items()
}
ITEMS = [
    CloneItem("spatial_data_warehouse", "dbo", name, name, source_note="Spatial Data Warehouse layer")
    for name in CONFIG["items"]
]
OUTPUT_ROOT = Path(CONFIG["output_root"])
if not OUTPUT_ROOT.is_absolute():
    OUTPUT_ROOT = CONFIG_PATH.parent / OUTPUT_ROOT


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Rebuild the dedicated Spatial Data Warehouse DuckDB mirror. "
            "The mirror is intentionally separate from the standard source archive."
        )
    )
    parser.add_argument("--list", action="store_true", help="Print the layer manifest and exit.")
    parser.add_argument("--write-manifest", type=Path, default=None)
    parser.add_argument("--continue-on-error", action="store_true")
    args = parser.parse_args(argv)

    if args.write_manifest:
        write_manifest_csv(args.write_manifest, ITEMS, DATABASES)
    if args.list:
        print_manifest(ITEMS, DATABASES)
        return 0

    return 1 if run_clone(
        output_root=OUTPUT_ROOT,
        items=ITEMS,
        continue_on_error=args.continue_on_error,
        odbc_driver=str(CONFIG["odbc_driver"]),
        trust_server_certificate=True,
        create_filegdb=False,
        databases=DATABASES,
        build_spatial_indexes=True,
    ) else 0


if __name__ == "__main__":
    raise SystemExit(main())
