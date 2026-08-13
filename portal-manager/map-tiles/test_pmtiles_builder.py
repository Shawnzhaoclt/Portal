from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
import sys
import tempfile
import unittest


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIRECTORY))

import build_pmtiles_from_duckdb as builder
from pmtiles_v3 import read_header, tile_id_to_zxy, zxy_to_tile_id


class PmtilesBuilderTests(unittest.TestCase):
    def test_hilbert_tile_ids_round_trip(self) -> None:
        for zoom in range(6):
            for x in range(1 << zoom):
                for y in range(1 << zoom):
                    self.assertEqual(tile_id_to_zxy(zxy_to_tile_id(zoom, x, y)), (zoom, x, y))

    def test_builds_and_validates_a_pmtiles_archive_from_duckdb(self) -> None:
        duckdb = builder._load_duckdb()
        with tempfile.TemporaryDirectory() as temporary_value:
            temporary = Path(temporary_value)
            database = temporary / "source.duckdb"
            connection = duckdb.connect(str(database))
            try:
                connection.execute("LOAD spatial")
                connection.execute(
                    """
                    CREATE TABLE test_points (
                        objectid INTEGER,
                        label VARCHAR,
                        shape GEOMETRY,
                        __geometry_srid INTEGER
                    )
                    """
                )
                connection.execute(
                    """
                    CREATE TABLE test_lines (
                        objectid INTEGER,
                        category VARCHAR,
                        shape GEOMETRY,
                        __geometry_srid INTEGER
                    )
                    """
                )
                connection.execute(
                    """
                    CREATE TABLE test_geometry_only (
                        objectid INTEGER,
                        shape GEOMETRY,
                        __geometry_srid INTEGER
                    )
                    """
                )
                connection.execute(
                    """
                    INSERT INTO test_lines VALUES
                        (10, 'test', ST_GeomFromText('LINESTRING(-80.9 35.2, -80.7 35.3)'), 4326)
                    """
                )
                connection.execute(
                    """
                    INSERT INTO test_points VALUES
                        (1, 'Charlotte', ST_GeomFromText('POINT(-80.8431 35.2271)'), 4326),
                        (2, 'Mint Hill', ST_GeomFromText('POINT(-80.6473 35.1796)'), 4326)
                    """
                )
                connection.execute(
                    """
                    INSERT INTO test_geometry_only VALUES
                        (20, ST_GeomFromText('POINT(-80.75 35.25)'), 4326)
                    """
                )
            finally:
                connection.close()

            output = temporary / "tiles" / "test.pmtiles"
            config_path = temporary / "pmtiles.settings.json"
            config_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "defaults": {
                            "maximumZoom": 8,
                            "temporaryDirectory": str(temporary / "work"),
                            "progressFile": str(temporary / "progress.json"),
                            "workerCount": 2,
                            "threadsPerWorker": 2,
                            "engine": "python",
                        },
                        "sources": [
                            {
                                "id": "test-source",
                                "database": str(database),
                                "schema": "main",
                                "layers": [
                                    {
                                        "id": "test-points",
                                        "table": "test_points",
                                        "featureIdColumn": "objectid",
                                        "minimumZoom": 8,
                                        "maximumZoom": 8,
                                        "properties": ["label"],
                                    },
                                    {
                                        "id": "test-lines",
                                        "table": "test_lines",
                                        "featureIdColumn": "objectid",
                                        "minimumZoom": 8,
                                        "maximumZoom": 8,
                                        "properties": ["category"],
                                    },
                                    {
                                        "id": "test-geometry-only",
                                        "table": "test_geometry_only",
                                        "featureIdColumn": "objectid",
                                        "minimumZoom": 8,
                                        "maximumZoom": 8,
                                        "properties": [],
                                    },
                                ],
                            }
                        ],
                        "tilesets": [
                            {
                                "id": "test-tileset",
                                "name": "Test tileset",
                                "output": str(output),
                                "sources": ["test-source"],
                                "enabled": True,
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            status = builder.status_payload(config_path)
            self.assertEqual(status["tilesetCount"], 1)
            self.assertEqual(status["layerCount"], 3)
            self.assertEqual(status["tilesets"][0]["workerCount"], 2)

            _config, tilesets = builder.load_tilesets(config_path)
            manifest = builder.build_tileset(tilesets[0])

            self.assertTrue(output.is_file())
            self.assertGreater(output.stat().st_size, 127)
            self.assertGreater(manifest["tileCount"], 0)
            self.assertEqual(len(manifest["layers"]), 3)
            self.assertEqual(manifest["layers"][0]["featureCount"], 2)
            self.assertEqual(manifest["layers"][0]["properties"], ["label"])
            self.assertEqual(manifest["layers"][0]["sourceId"], "test-source")
            self.assertEqual(manifest["layers"][0]["geometryColumn"], "shape")
            self.assertEqual(manifest["layers"][0]["featureIdField"], "__portal_feature_id")
            self.assertEqual(manifest["layers"][0]["sourceFeatureIdColumn"], "objectid")
            self.assertEqual(manifest["layers"][0]["featureIdStrategy"], "source:objectid")
            self.assertEqual(manifest["layers"][0]["featureHashColumns"], [])
            self.assertEqual(manifest["layers"][1]["featureCount"], 1)
            self.assertEqual(manifest["layers"][2]["featureCount"], 1)
            self.assertEqual(manifest["workerCount"], 2)
            self.assertTrue(output.with_suffix(".pmtiles.manifest.json").is_file())

            header = read_header(output)
            self.assertEqual(header["min_zoom"], 8)
            self.assertEqual(header["max_zoom"], 8)
            self.assertEqual(header["addressed_tiles_count"], manifest["tileCount"])
            progress = json.loads((temporary / "progress.json").read_text(encoding="utf-8"))
            self.assertEqual(progress["status"], "succeeded")
            self.assertEqual(progress["completedLayers"], 3)
            self.assertEqual(progress["workerCount"], 2)

            tippecanoe_output = temporary / "tiles" / "test-tippecanoe.pmtiles"
            tippecanoe_layers = (
                replace(tilesets[0].layers[0], minimum_zoom=7),
                *tilesets[0].layers[1:],
            )
            tippecanoe_tileset = replace(
                tilesets[0],
                output=tippecanoe_output,
                layers=tippecanoe_layers,
                engine="tippecanoe",
                fallback_engine="",
                tippecanoe_threads="2",
            )
            tippecanoe_manifest = builder.build_tileset(tippecanoe_tileset)
            self.assertEqual(tippecanoe_manifest["engine"], "tippecanoe")
            self.assertEqual(tippecanoe_manifest["zoomGroupCount"], 2)
            self.assertEqual(tippecanoe_manifest["tippecanoeGroupWorkers"], 2)
            self.assertTrue(tippecanoe_output.is_file())
            self.assertGreater(tippecanoe_manifest["tileCount"], 0)
            self.assertEqual(tippecanoe_manifest["layers"][0]["properties"], ["label"])
            self.assertEqual(tippecanoe_manifest["layers"][1]["properties"], ["category"])
            self.assertEqual(tippecanoe_manifest["layers"][2]["properties"], [])
            self.assertTrue(
                all(item["featureIdField"] == "__portal_feature_id" for item in tippecanoe_manifest["layers"])
            )
            self.assertTrue(all(item["sourceId"] == "test-source" for item in tippecanoe_manifest["layers"]))
            self.assertTrue(all(item["geometryColumn"] == "shape" for item in tippecanoe_manifest["layers"]))
            tippecanoe_header = read_header(tippecanoe_output)
            self.assertEqual(tippecanoe_header["min_zoom"], 7)
            self.assertEqual(tippecanoe_header["max_zoom"], 8)
            tippecanoe_metadata = builder._read_pmtiles_metadata(
                tippecanoe_output, tippecanoe_header
            )
            tippecanoe_fields = {
                item["id"]: set(item.get("fields", {}))
                for item in tippecanoe_metadata["vector_layers"]
            }
            self.assertEqual(tippecanoe_fields["test-points"], {"label", "__portal_feature_id"})
            self.assertEqual(tippecanoe_fields["test-lines"], {"category", "__portal_feature_id"})
            self.assertEqual(tippecanoe_fields["test-geometry-only"], {"__portal_feature_id"})
            progress = json.loads((temporary / "progress.json").read_text(encoding="utf-8"))
            self.assertEqual(progress["status"], "succeeded")
            self.assertEqual(progress["engine"], "tippecanoe")
            self.assertEqual(progress["phase"], "published")

            gdal_output = temporary / "tiles" / "test-gdal.pmtiles"
            gdal_tileset = replace(
                tilesets[0],
                output=gdal_output,
                engine="gdal",
                fallback_engine="",
                gdal_threads="2",
            )
            gdal_manifest = builder.build_tileset(gdal_tileset)
            self.assertEqual(gdal_manifest["engine"], "gdal")
            self.assertTrue(gdal_output.is_file())
            self.assertGreater(gdal_manifest["tileCount"], 0)
            self.assertEqual(gdal_manifest["layers"][0]["properties"], ["label"])
            self.assertEqual(gdal_manifest["layers"][1]["properties"], ["category"])
            self.assertEqual(gdal_manifest["layers"][2]["properties"], [])
            gdal_header = read_header(gdal_output)
            self.assertEqual(gdal_header["min_zoom"], 8)
            self.assertEqual(gdal_header["max_zoom"], 8)
            gdal_metadata = builder._read_pmtiles_metadata(gdal_output, gdal_header)
            fields_by_layer = {
                item["id"]: set(item.get("fields", {}))
                for item in gdal_metadata["vector_layers"]
            }
            self.assertEqual(fields_by_layer["test-points"], {"label", "__portal_feature_id"})
            self.assertEqual(fields_by_layer["test-lines"], {"category", "__portal_feature_id"})
            self.assertEqual(fields_by_layer["test-geometry-only"], {"__portal_feature_id"})
            progress = json.loads((temporary / "progress.json").read_text(encoding="utf-8"))
            self.assertEqual(progress["status"], "succeeded")
            self.assertEqual(progress["engine"], "gdal")
            self.assertEqual(progress["phase"], "published")

    def test_include_layers_is_an_exact_required_allowlist(self) -> None:
        duckdb = builder._load_duckdb()
        with tempfile.TemporaryDirectory() as temporary_value:
            temporary = Path(temporary_value)
            database = temporary / "source.duckdb"
            connection = duckdb.connect(str(database))
            try:
                connection.execute("LOAD spatial")
                connection.execute("CREATE TABLE approved_layer (shape GEOMETRY)")
                connection.execute("CREATE TABLE unrelated_layer (shape GEOMETRY)")
            finally:
                connection.close()

            config_path = temporary / "pmtiles.settings.json"
            config = {
                "schemaVersion": 1,
                "defaults": {
                    "sourceSrid": 4326,
                    "temporaryDirectory": str(temporary / "work"),
                },
                "sources": [
                    {
                        "id": "test-source",
                        "database": str(database),
                        "schema": "main",
                        "includeAllSpatialTables": True,
                    }
                ],
                "tilesets": [
                    {
                        "id": "test-tileset",
                        "name": "Test tileset",
                        "output": str(temporary / "tiles" / "test.pmtiles"),
                        "sources": ["test-source"],
                        "includeLayers": ["approved_layer"],
                    }
                ],
            }
            config_path.write_text(json.dumps(config), encoding="utf-8")

            _config, tilesets = builder.load_tilesets(config_path)
            self.assertEqual([layer.layer_id for layer in tilesets[0].layers], ["approved_layer"])

            config["tilesets"][0]["includeLayers"].append("missing_layer")
            config_path.write_text(json.dumps(config), encoding="utf-8")
            with self.assertRaisesRegex(
                RuntimeError,
                r"test-tileset is missing configured layers: missing_layer",
            ):
                builder.load_tilesets(config_path)

    def test_portal_tilesets_and_resource_registry_share_the_68_layer_allowlist(self) -> None:
        config = json.loads((SCRIPT_DIRECTORY / "pmtiles.settings.json").read_text(encoding="utf-8"))
        portal_tilesets = [item for item in config["tilesets"] if item.get("enabled", True)]
        self.assertEqual(
            {item["id"] for item in portal_tilesets},
            {"core_storm", "property_surfaces", "planning_projects", "transport_reference"},
        )
        configured_layers = [
            str(layer).lower()
            for tileset in portal_tilesets
            for layer in tileset["includeLayers"]
        ]
        configured = set(configured_layers)
        registry_path = (
            SCRIPT_DIRECTORY.parents[1]
            / "python"
            / "portal"
            / "app"
            / "resources"
            / "maps"
            / "stm_risk_map"
            / "assets"
            / "maplibre"
            / "portal-layer-source-ids.json"
        )
        registered = {
            str(item).lower()
            for item in json.loads(registry_path.read_text(encoding="utf-8"))
        }

        archive_registry_path = registry_path.with_name("portal-layer-archives.json")
        archive_registry = json.loads(archive_registry_path.read_text(encoding="utf-8"))
        registered_by_archive = {
            archive_id: {str(layer).lower() for layer in layers}
            for archive_id, layers in archive_registry.items()
        }

        self.assertEqual(len(configured), 68)
        self.assertEqual(len(configured_layers), len(configured))
        self.assertIn("topo_ln", configured)
        self.assertIn("stormpipes_ln", configured)
        self.assertNotIn("culverts", configured)
        self.assertNotIn("cw_inspections_all_pt", configured)
        self.assertNotIn("itpipes_defects_top_risk_pt", configured)
        self.assertEqual(configured, registered)
        self.assertEqual(
            {item["id"]: {str(layer).lower() for layer in item["includeLayers"]} for item in portal_tilesets},
            registered_by_archive,
        )

        _config, resolved_tilesets = builder.load_tilesets(SCRIPT_DIRECTORY / "pmtiles.settings.json")
        resolved_layers = [layer for tileset in resolved_tilesets for layer in tileset.layers]
        generated_layers = {
            layer.layer_id for layer in resolved_layers if layer.feature_id_strategy == "generated_hash"
        }
        self.assertEqual(
            generated_layers,
            {"capitalimprovementprojects_vln", "capitalimprovementprojects_vpt"},
        )
        self.assertTrue(
            all(
                layer.feature_id_column in {"OBJECTID", "OBJECTID_1"}
                for layer in resolved_layers
                if layer.feature_id_strategy != "generated_hash"
            )
        )

    def test_planning_layer_ids_use_configured_direct_duckdb_sources(self) -> None:
        portal_root = SCRIPT_DIRECTORY.parents[1]
        config = json.loads(
            (portal_root / "desktop" / "config" / "desktop-config.template.json").read_text(
                encoding="utf-8"
            )
        )
        layers = config["maps"]["duckdbGeoJsonLayers"]
        mappings = {
            str(layer["id"]).lower(): (str(layer["database"]), str(layer["table"]))
            for layer in layers
        }

        self.assertEqual(len(mappings), 11)
        self.assertEqual(
            mappings["culverts"],
            (
                "${PORTAL_DATA_ROOT}/data/source-cache/unavailable/mirror.cityworks-spatial/myrs_cwdbprd_1_stw_cityworks_sd.duckdb",
                "Culverts_evw",
            ),
        )
        self.assertEqual(
            mappings["cw_inspections_all_pt"][1],
            "CW_SCORED_ASSET_INSPECTIONS_ALL_PT",
        )
        self.assertEqual(
            mappings["proactive_inv_pv_cw_ln"][1],
            "PROACTIVE_INV_PV_CW_LN",
        )
        self.assertTrue(
            all(database.startswith("${PORTAL_DATA_ROOT}/data/source-cache/unavailable/") for database, _table in mappings.values())
        )


if __name__ == "__main__":
    unittest.main()
