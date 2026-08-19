from __future__ import annotations

import importlib.util
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from portal.app.core import secure_catalog
from portal.app.core.secure_catalog import encrypt_plaintext_system_catalog


@unittest.skipUnless(importlib.util.find_spec("sqlcipher3"), "SQLCipher is not installed")
class SecureCatalogTests(unittest.TestCase):
    def test_plaintext_catalog_is_exported_as_sqlcipher(self) -> None:
        with tempfile.TemporaryDirectory(prefix="portal-secure-catalog-") as directory:
            source = Path(directory) / "source.db"
            destination = Path(directory) / "encrypted.db"
            connection = sqlite3.connect(source)
            connection.execute("CREATE TABLE SYS_TEST(id INTEGER PRIMARY KEY, value TEXT)")
            connection.execute("INSERT INTO SYS_TEST(value) VALUES ('verified')")
            connection.commit()
            connection.close()

            with patch.dict("os.environ", {"PORTAL_SYSTEM_DB_KEY": "11" * 32}):
                result = encrypt_plaintext_system_catalog(source, destination)

            self.assertEqual(result["status"], "succeeded")
            self.assertEqual(result["objectCount"], 1)
            self.assertNotEqual(destination.read_bytes()[:16], b"SQLite format 3\0")
            with self.assertRaises(sqlite3.DatabaseError):
                connection = sqlite3.connect(destination)
                try:
                    connection.execute("SELECT * FROM SYS_TEST").fetchall()
                finally:
                    connection.close()

    def test_catalog_row_factory_is_adapted_without_changing_business_sqlite(self) -> None:
        with tempfile.TemporaryDirectory(prefix="portal-secure-catalog-hook-") as directory:
            root = Path(directory)
            source = root / "source.db"
            encrypted = root / "system.db"
            business = root / "stormwater.db"
            key = "22" * 32

            source_connection = sqlite3.connect(source)
            source_connection.execute("CREATE TABLE SYS_USERS(id INTEGER, name TEXT)")
            source_connection.execute("INSERT INTO SYS_USERS VALUES (1, 'Shawn')")
            source_connection.commit()
            source_connection.close()
            business_connection = sqlite3.connect(business)
            business_connection.execute("CREATE TABLE records(id INTEGER, value TEXT)")
            business_connection.commit()
            business_connection.close()

            with patch.dict("os.environ", {"PORTAL_SYSTEM_DB_KEY": key}):
                encrypt_plaintext_system_catalog(source, encrypted)

            original_connect = sqlite3.connect
            original_dbapi_connect = sqlite3.dbapi2.connect
            previous_hook_state = secure_catalog._HOOK_INSTALLED
            try:
                secure_catalog._HOOK_INSTALLED = False
                with patch.dict(
                    os.environ,
                    {
                        "PORTAL_SYSTEM_DB_ENCRYPTED": "1",
                        "PORTAL_SYSTEM_DB": str(encrypted),
                        "PORTAL_SYSTEM_DB_KEY": key,
                    },
                    clear=False,
                ):
                    secure_catalog.install_system_catalog_sqlcipher_hook()

                    catalog_connection = sqlite3.connect(encrypted)
                    catalog_connection.row_factory = sqlite3.Row
                    catalog_row = catalog_connection.execute(
                        "SELECT id, name FROM SYS_USERS"
                    ).fetchone()
                    self.assertEqual(catalog_row["name"], "Shawn")
                    self.assertEqual(type(catalog_row).__module__, "sqlcipher3.dbapi2")
                    catalog_connection.close()

                    writable_business = sqlite3.connect(business)
                    self.assertIsInstance(writable_business, sqlite3.Connection)
                    writable_business.row_factory = sqlite3.Row
                    writable_business.execute("INSERT INTO records VALUES (1, 'writable')")
                    writable_business.commit()
                    business_row = writable_business.execute(
                        "SELECT value FROM records WHERE id = 1"
                    ).fetchone()
                    self.assertEqual(business_row["value"], "writable")
                    self.assertIsInstance(business_row, sqlite3.Row)
                    writable_business.close()
            finally:
                sqlite3.connect = original_connect
                sqlite3.dbapi2.connect = original_dbapi_connect
                secure_catalog._HOOK_INSTALLED = previous_hook_state


if __name__ == "__main__":
    unittest.main()
