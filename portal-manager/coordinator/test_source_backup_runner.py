from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import source_backup_runner as runner


class SourceBackupRunnerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.scripts = self.root / "source-backup"
        self.scripts.mkdir()
        for name in runner.REQUIRED_FILES:
            (self.scripts / name).write_text("\n", encoding="utf-8")
        (self.scripts / "clone_sqlserver_to_duckdb.py").write_text(
            "print('registered sources')\n",
            encoding="utf-8",
        )
        source = self.root / "sources"
        source.mkdir()
        backup = self.root / "backups"
        backup.mkdir()
        (backup / "duckdb_backup_2026-08-10.zip").write_bytes(b"archive")
        (self.scripts / "backup_duckdb_files.json").write_text(
            json.dumps(
                {
                    "duckdb_source_dir": str(source),
                    "backup_dir": str(backup),
                    "directory_sources": [],
                    "archive_prefix": "duckdb_backup",
                    "retention_days": 180,
                    "email": {"mechanism": "outlook", "to_addresses": ["operator@example.gov"]},
                }
            ),
            encoding="utf-8",
        )
        (self.scripts / "clone_sqlserver_to_duckdb.json").write_text(
            json.dumps(
                {
                    "output_root": str(source),
                    "odbc_driver": "ODBC Driver 17 for SQL Server",
                    "create_filegdb": True,
                    "databases": {
                        "secured": {
                            "server": "example",
                            "database": "example",
                            "duckdb_name": "example.duckdb",
                            "auth_method": "sql_server",
                            "username": "reader",
                            "password": "",
                            "password_env": "PORTAL_TEST_SQL_PASSWORD",
                        }
                    },
                }
            ),
            encoding="utf-8",
        )
        (self.scripts / "clone_spatial_data_warehouse_to_duckdb.json").write_text(
            json.dumps(
                {
                    "output_root": str(source),
                    "odbc_driver": "ODBC Driver 17 for SQL Server",
                    "create_filegdb": False,
                    "databases": {
                        "spatial": {
                            "server": "example",
                            "database": "SDW",
                            "duckdb_name": "spatial.duckdb",
                        }
                    },
                    "items": ["LayerOne", "LayerTwo"],
                }
            ),
            encoding="utf-8",
        )
        self.map_tiles = self.root / "map-tiles"
        self.map_tiles.mkdir()
        (self.map_tiles / "build_pmtiles_from_duckdb.py").write_text(
            "print('validated map tiles')\n",
            encoding="utf-8",
        )
        (self.map_tiles / "pmtiles_v3.py").write_text("\n", encoding="utf-8")
        self.map_progress = self.root / "map-progress.json"
        (self.map_tiles / "pmtiles.settings.json").write_text(
            json.dumps(
                {
                    "sharedDataRoot": str(self.root),
                    "defaults": {"progressFile": str(self.map_progress)},
                    "tilesets": [
                        {
                            "id": "test",
                            "name": "Test tiles",
                            "output": "${PORTAL_SHARED_DATA_ROOT}/tiles/test.pmtiles",
                            "enabled": True,
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        self.data_publication = self.root / "data-publication"
        self.data_publication.mkdir()
        (self.data_publication / "publish_data_versions.py").write_text(
            "print('published data versions')\n",
            encoding="utf-8",
        )
        (self.data_publication / "publication.settings.json").write_text(
            json.dumps({"sharedDataRoot": str(self.root), "producers": {}}),
            encoding="utf-8",
        )
        self.settings = self.root / "workstation-manager.settings.json"
        self.settings.write_text(
            json.dumps(
                {
                    "sourceBackupDirectory": str(self.scripts),
                    "sourceBackupPythonExecutable": os.fspath(Path(os.sys.executable)),
                    "sourceBackupWeekday": "SAT",
                    "mapTilesDirectory": str(self.map_tiles),
                    "mapTilesSettingsFile": "pmtiles.settings.json",
                    "dataPublicationDirectory": str(self.data_publication),
                    "dataPublicationScript": "publish_data_versions.py",
                    "dataPublicationSettingsFile": "publication.settings.json",
                }
            ),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_status_reports_inventory_without_exposing_credentials(self) -> None:
        with patch.dict(os.environ, {"LOCALAPPDATA": str(self.root / "local")}, clear=False):
            result = runner.status(self.settings)
        self.assertTrue(result["available"])
        self.assertTrue(result["map_tiles_available"])
        self.assertEqual(result["map_tiles_tileset_count"], 1)
        self.assertFalse(result["refresh_ready"])
        self.assertEqual(result["database_count"], 1)
        self.assertEqual(result["archive_count"], 1)
        self.assertEqual(result["archives"][0]["name"], "duckdb_backup_2026-08-10.zip")
        serialized = json.dumps(result).lower()
        self.assertNotIn('"password"', serialized)
        self.assertNotIn("reader", serialized)

    def test_check_action_records_a_successful_run(self) -> None:
        with patch.dict(os.environ, {"LOCALAPPDATA": str(self.root / "local")}, clear=False):
            self.assertEqual(runner.run_action(self.settings, "check"), 0)
            result = runner.status(self.settings)
        self.assertEqual(result["state"]["status"], "succeeded")
        self.assertEqual(result["runs"][0]["action"], "check")
        self.assertGreaterEqual(result["runs"][0]["duration_seconds"], 0)

    def test_status_includes_live_map_tile_progress(self) -> None:
        self.map_progress.write_text(
            json.dumps(
                {
                    "status": "building",
                    "totalLayers": 67,
                    "completedLayers": 12,
                    "workerCount": 3,
                }
            ),
            encoding="utf-8",
        )
        with patch.dict(os.environ, {"LOCALAPPDATA": str(self.root / "local")}, clear=False):
            result = runner.status(self.settings)
        self.assertEqual(result["map_tiles_progress"]["status"], "building")
        self.assertEqual(result["map_tiles_progress"]["completedLayers"], 12)

    def test_map_tiles_action_uses_the_portal_owned_builder(self) -> None:
        with patch.dict(os.environ, {"LOCALAPPDATA": str(self.root / "local")}, clear=False):
            self.assertEqual(runner.run_action(self.settings, "map_tiles"), 0)
            result = runner.status(self.settings)
        self.assertEqual(result["state"]["status"], "succeeded")
        self.assertEqual(result["runs"][0]["action"], "map_tiles")
        self.assertIn("PMTiles", result["runs"][0]["details"])

    def test_weekly_workflow_builds_map_tiles_after_the_spatial_mirror(self) -> None:
        settings = json.loads(self.settings.read_text(encoding="utf-8"))
        settings["sourceBackupWeekday"] = datetime.now().strftime("%a").upper()
        self.settings.write_text(json.dumps(settings), encoding="utf-8")
        commands: list[list[str]] = []

        def record_command(command: list[str], _log_file: object, _cwd: Path) -> None:
            commands.append(command)

        with (
            patch.dict(os.environ, {"LOCALAPPDATA": str(self.root / "local")}, clear=False),
            patch.object(runner, "_hydrate_source_credentials"),
            patch.object(runner, "_run_logged", side_effect=record_command),
            patch.object(runner, "_send_workflow_notification"),
        ):
            self.assertEqual(runner.run_action(self.settings, "workflow"), 0)
            result = runner.status(self.settings)

        script_names = [Path(command[1]).name for command in commands]
        self.assertEqual(
            script_names,
            [
                "backup_duckdb_files.py",
                "clone_sqlserver_to_duckdb.py",
                "publish_data_versions.py",
                "clone_spatial_data_warehouse_to_duckdb.py",
                "build_pmtiles_from_duckdb.py",
                "publish_data_versions.py",
                "publish_data_versions.py",
            ],
        )
        self.assertEqual(result["runs"][0]["status"], "succeeded")
        self.assertIn("PMTiles", result["runs"][0]["details"])

    def test_status_backfills_duration_for_legacy_history(self) -> None:
        local_app_data = self.root / "local"
        state_directory = local_app_data / "PortalManager" / "source-backup"
        state_directory.mkdir(parents=True)
        (state_directory / "history.json").write_text(
            json.dumps(
                {
                    "runs": [
                        {
                            "run_id": "legacy",
                            "started_at": "2026-08-11T14:00:00-04:00",
                            "finished_at": "2026-08-11T14:22:22-04:00",
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )

        with patch.dict(os.environ, {"LOCALAPPDATA": str(local_app_data)}, clear=False):
            result = runner.status(self.settings)

        self.assertEqual(result["runs"][0]["duration_seconds"], 1342.0)

    def test_history_keeps_only_the_ten_most_recent_logs(self) -> None:
        state_directory = self.root / "state"
        log_directory = state_directory / "logs"
        log_directory.mkdir(parents=True)

        for index in range(12):
            log_path = log_directory / f"source-backup-{index}.log"
            log_path.write_text("log", encoding="utf-8")
            runner._append_history(
                state_directory,
                {"run_id": str(index), "log_path": str(log_path)},
            )

        history = json.loads((state_directory / "history.json").read_text(encoding="utf-8"))
        self.assertEqual(len(history["runs"]), 10)
        self.assertEqual(history["runs"][0]["run_id"], "11")
        self.assertEqual(history["runs"][-1]["run_id"], "2")
        self.assertFalse((log_directory / "source-backup-0.log").exists())
        self.assertFalse((log_directory / "source-backup-1.log").exists())
        self.assertTrue((log_directory / "source-backup-2.log").exists())


if __name__ == "__main__":
    unittest.main()
