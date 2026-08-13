from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from portal.app.core.duckdb_extensions import (
    DuckDBSpatialExtensionError,
    load_spatial_extension,
)


class FakeConnection:
    def __init__(self) -> None:
        self.statements: list[str] = []
        self.loaded: list[str] = []

    def execute(self, statement: str):
        self.statements.append(statement)
        return self

    def fetchone(self):
        return ("windows_amd64",)

    def load_extension(self, path: str) -> None:
        self.loaded.append(path)


class DuckDBExtensionTests(unittest.TestCase):
    def test_loads_explicit_local_extension_and_disables_network_fallbacks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_value:
            extension = Path(temporary_value) / "spatial.duckdb_extension"
            extension.write_bytes(b"test")
            connection = FakeConnection()
            with patch.dict(
                os.environ,
                {"PORTAL_DUCKDB_SPATIAL_EXTENSION": str(extension)},
                clear=False,
            ):
                loaded = load_spatial_extension(connection)

        self.assertEqual(loaded, extension)
        self.assertEqual(connection.loaded, [str(extension)])
        self.assertIn("SET autoinstall_known_extensions = false", connection.statements)
        self.assertIn("SET autoload_known_extensions = false", connection.statements)
        self.assertFalse(any("INSTALL spatial" in statement for statement in connection.statements))

    def test_missing_extension_requires_full_reinstallation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_value:
            missing = Path(temporary_value) / "missing.duckdb_extension"
            connection = FakeConnection()
            with (
                patch.dict(
                    os.environ,
                    {
                        "PORTAL_DUCKDB_SPATIAL_EXTENSION": str(missing),
                        "PORTAL_APP_ROOT": temporary_value,
                    },
                    clear=False,
                ),
                patch("portal.app.core.duckdb_extensions.Path.home", return_value=Path(temporary_value)),
            ):
                with self.assertRaisesRegex(DuckDBSpatialExtensionError, "full portable release"):
                    load_spatial_extension(connection)

        self.assertEqual(connection.loaded, [])
        self.assertFalse(any("INSTALL spatial" in statement for statement in connection.statements))


if __name__ == "__main__":
    unittest.main()
