from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

import publish_data_versions as publisher


class PublicationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.shared = self.root / "shared"
        self.shared.mkdir()
        self.config = self.root / "publication.settings.json"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _sqlite(self, relative: str, table: str) -> Path:
        path = self.shared / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(path)
        connection.execute(f"CREATE TABLE {table} (id INTEGER PRIMARY KEY, value TEXT)")
        connection.commit()
        connection.close()
        return path

    def _write_config(self) -> None:
        value = {
            "sharedDataRoot": str(self.shared),
            "centralManifest": "portal-data.current.json",
            "publicationsDirectory": "publications",
            "producers": {
                "one": {
                    "fragment": "one.current.json",
                    "sources": [{
                        "id": "source.one", "path": "one.db", "format": "sqlite",
                        "desktopEnabled": True, "activationGroup": "one"
                    }],
                },
                "two": {
                    "fragment": "two.current.json",
                    "sources": [{
                        "id": "source.two", "path": "two.db", "format": "sqlite",
                        "desktopEnabled": True, "activationGroup": "two"
                    }],
                },
            },
        }
        self.config.write_text(json.dumps(value), encoding="utf-8")

    def test_fragments_merge_without_losing_other_producer(self) -> None:
        self._sqlite("one.db", "one_table")
        self._sqlite("two.db", "two_table")
        self._write_config()
        publisher.publish(self.config, "one")
        publisher.publish(self.config, "two")
        central = json.loads((self.shared / "portal-data.current.json").read_text())
        self.assertEqual(["source.one", "source.two"], sorted(item["id"] for item in central["sources"]))

    def test_unchanged_content_keeps_source_version(self) -> None:
        self._sqlite("one.db", "one_table")
        self._sqlite("two.db", "two_table")
        self._write_config()
        publisher.publish(self.config, "one")
        first = json.loads((self.shared / "publications" / "one.current.json").read_text())
        publisher.publish(self.config, "one")
        second = json.loads((self.shared / "publications" / "one.current.json").read_text())
        self.assertEqual(first["sources"][0]["version"], second["sources"][0]["version"])
        self.assertNotEqual(first["producerReleaseId"], second["producerReleaseId"])

    def test_stage_source_copies_catalog_below_shared_root(self) -> None:
        source = self._sqlite("authoritative.db", "catalog")
        self._write_config()
        value = json.loads(self.config.read_text())
        value["producers"]["catalog"] = {
            "fragment": "catalog.current.json",
            "sources": [{
                "id": "system.catalog", "path": "system/system.db", "format": "sqlite",
                "desktopEnabled": True, "readOnly": True
            }],
        }
        self.config.write_text(json.dumps(value), encoding="utf-8")
        publisher.publish(self.config, "catalog", {"system.catalog": source})
        self.assertTrue((self.shared / "system" / "system.db").is_file())

    def test_prepared_transaction_is_recovered_and_checked(self) -> None:
        self._sqlite("one.db", "one_table")
        self._sqlite("two.db", "two_table")
        self._write_config()
        publisher.publish(self.config, "one")
        publications = self.shared / "publications"
        fragment_path = publications / "one.current.json"
        fragment = json.loads(fragment_path.read_text())
        (publications / "one.transaction.json").write_text(
            json.dumps({"state": "prepared", "producer": "one", "fragment": fragment}),
            encoding="utf-8",
        )
        fragment_path.unlink()
        (self.shared / "portal-data.current.json").unlink()
        recovered = publisher.recover_prepared(self.config)
        self.assertEqual(["one"], recovered["recovered"])
        checked = publisher.check_publication(self.config)
        self.assertEqual(1, checked["source_count"])

    def test_sqlite_validation_uses_native_query_only_connection(self) -> None:
        database = self._sqlite("network-style.db", "catalog")
        real_connect = sqlite3.connect
        with mock.patch.object(
            publisher.sqlite3,
            "connect",
            side_effect=lambda value, **kwargs: real_connect(value, **kwargs),
        ) as connect:
            publisher._sqlite_schema(database)
        connect.assert_called_once_with(str(database))

    def test_big_tiff_header_is_accepted_for_large_cog(self) -> None:
        path = self.root / "terrain.tif"
        path.write_bytes(b"II+\x00\x08\x00\x00\x00\xc8\x00\x00\x00\x00\x00\x00\x00")
        self.assertEqual(64, len(publisher._tiff_schema(path)))


if __name__ == "__main__":
    unittest.main()
