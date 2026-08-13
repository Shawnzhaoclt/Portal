from __future__ import annotations

import importlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


map_app = importlib.import_module("portal.app.resources.maps.stm_risk_map.app")


class PmtilesFeatureDetailsTests(unittest.TestCase):
    def test_loads_all_non_geometry_fields_by_source_internal_id(self) -> None:
        duckdb = importlib.import_module("duckdb")
        with tempfile.TemporaryDirectory() as temporary_value:
            database = Path(temporary_value) / "source.duckdb"
            connection = duckdb.connect(str(database))
            try:
                connection.execute(
                    """
                    CREATE TABLE source_features (
                        OBJECTID BIGINT,
                        asset_name VARCHAR,
                        risk_score DOUBLE,
                        optional_note VARCHAR,
                        raw_payload BLOB
                    )
                    """
                )
                connection.execute(
                    "INSERT INTO source_features VALUES (1481, 'FEMA Floodplain', 17.25, NULL, blob 'abc')"
                )
            finally:
                connection.close()

            layer_manifest = {
                "sourceId": "spatial-data-warehouse",
                "table": "source_features",
                "featureIdField": "__portal_feature_id",
                "sourceFeatureIdColumn": "OBJECTID",
                "featureIdStrategy": "source_internal_id",
                "geometryColumn": "",
                "featureHashColumns": [],
            }
            detail_sources = {
                "spatial-data-warehouse": {
                    "databaseSourceId": "mirror.sdw-spatial",
                    "database": str(database),
                    "databaseFileName": database.name,
                }
            }

            def open_test_database(layer: dict[str, object], _label: str = ""):
                return duckdb.connect(str(layer["database"]), read_only=True)

            with (
                patch.object(
                    map_app,
                    "portal_pmtiles_layer_manifest",
                    return_value=(layer_manifest, "portal_property_surfaces.pmtiles", "weekly-2026-08-08"),
                ),
                patch.object(map_app, "configured_pmtiles_detail_sources", return_value=detail_sources),
                patch.object(map_app, "open_configured_duckdb", side_effect=open_test_database),
            ):
                result = map_app.query_pmtiles_feature_details(object(), "femafloodplain_py", "1481")

            self.assertTrue(result["ok"])
            self.assertEqual(result["source_id"], "mirror.sdw-spatial")
            self.assertEqual(result["table"], "source_features")
            self.assertEqual(result["feature_id"], "1481")
            fields = {item["name"]: item for item in result["fields"]}
            self.assertEqual(fields["OBJECTID"]["value"], 1481)
            self.assertEqual(fields["asset_name"]["value"], "FEMA Floodplain")
            self.assertEqual(fields["risk_score"]["value"], 17.25)
            self.assertIsNone(fields["optional_note"]["value"])
            self.assertTrue(fields["raw_payload"]["binary_omitted"])
            self.assertIsNone(fields["raw_payload"]["value"])


if __name__ == "__main__":
    unittest.main()
