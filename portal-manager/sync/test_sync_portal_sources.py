from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
from pathlib import Path


SCRIPT = Path(__file__).with_name("sync_portal_sources.py")


def load_sync_module():
    name = "portal_source_sync_test_module"
    spec = importlib.util.spec_from_file_location(name, SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_template_uses_only_serving_profile() -> None:
    payload = json.loads(SCRIPT.with_name("sync.settings.template.json").read_text(encoding="utf-8"))
    assert payload["publicationProfile"] == "portal_serving_v2"
    assert [source["key"] for source in payload["sources"]] == ["cityworks"]
    assert "tables" not in payload["sources"][0]
    assert "conditionRisk" in payload


def test_source_blank_text_is_preserved() -> None:
    sync = load_sync_module()
    row = (
        "42",
        42,
        "Critical Asset Inspection",
        "",
        "",
        "OPEN",
        None,
        None,
        None,
        None,
        None,
        "",
        None,
    )
    transformed = sync.transform_serving_row("critical_asset_work_orders", row)
    assert transformed[3] == ""
    assert transformed[4] == ""
    assert transformed[11] is None


def test_serving_contract_and_fingerprints(tmp_path: Path) -> None:
    sync = load_sync_module()
    database = tmp_path / "candidate.sqlite3"
    connection = sqlite3.connect(database)
    try:
        sync.metadata_schema(connection)
        for dataset in sync.SERVING_DATASETS:
            sync.create_serving_table(connection, dataset)
        connection.execute(
            "INSERT INTO critical_asset_work_orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("1", 1, "Critical Asset Inspection", "User", "Reviewer", "OPEN", None, None, "10", None, None, "Ready For Review", 5.0),
        )
        connection.execute(
            "INSERT INTO asset_inspection_workflows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (1, "10", None, "User", "PENDING", "User", 1, "OPEN", "Ready For Review", None, None),
        )
        connection.execute(
            "INSERT INTO asset_inspection_events VALUES (?, ?, ?, ?, ?)",
            (1, "inspection", "2026-08-06 12:00:00", "User", "PENDING"),
        )
        connection.execute(
            "INSERT INTO facility_condition_risk_current VALUES (?, ?)",
            ("10", 5.0),
        )
        sync.create_serving_indexes(connection)
        results = sync.validate_serving_tables(connection)
    finally:
        connection.close()

    assert set(results) == {dataset.key for dataset in sync.SERVING_DATASETS}
    assert results["critical_asset_work_orders"]["row_count"] == 1
    assert len(results["critical_asset_work_orders"]["sha256"]) == 64


def test_critical_team_reader_selects_serving_contract(tmp_path: Path) -> None:
    from portal.app.core.data_sources import CriticalTeamDataSource
    from portal.app.dashboards.critical_team.router import (
        critical_team_base_params,
        critical_team_source_cte,
        critical_team_uses_serving_tables,
    )

    database = tmp_path / "serving.sqlite3"
    connection = sqlite3.connect(database)
    try:
        connection.execute("CREATE TABLE critical_asset_work_orders (workorder_id TEXT)")
        connection.commit()
    finally:
        connection.close()
    manifest = tmp_path / "current.json"
    manifest.write_text(
        json.dumps({"format": "sqlite", "database": database.name}),
        encoding="utf-8",
    )
    source = CriticalTeamDataSource(
        source_type="sqlite_snapshot",
        workbook="",
        manifest=manifest,
        workorder_table="azteca_WORKORDER",
        wocustfield_table="azteca_WOCUSTFIELD",
        inspection_table="azteca_INSPECTION",
        workorder_entity_table="azteca_WORKORDERENTITY",
        activity_link_table="azteca_ACTIVITYLINK",
        critical_workorders_serving_table="critical_asset_work_orders",
        inspection_workflows_serving_table="asset_inspection_workflows",
        inspection_events_serving_table="asset_inspection_events",
        description_filter="Critical Asset Inspection",
    )

    assert critical_team_uses_serving_tables(source)
    assert "critical_asset_work_orders" in critical_team_source_cte(source)
    assert critical_team_base_params(source) == []
