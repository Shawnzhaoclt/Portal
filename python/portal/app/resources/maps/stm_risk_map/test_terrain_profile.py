from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import LineString

from .terrain_profile import _itpipes_profile_overlay, _sample_profile


class TerrainProfileTests(unittest.TestCase):
    def _write_dem(self, folder: Path) -> Path:
        path = folder / "terrain.tif"
        values = np.arange(100, dtype="float32").reshape((10, 10))
        with rasterio.open(
            path,
            "w",
            driver="GTiff",
            width=10,
            height=10,
            count=1,
            dtype="float32",
            crs="EPSG:2264",
            transform=from_origin(0, 100, 10, 10),
            nodata=-999999,
            tiled=True,
            blockxsize=16,
            blockysize=16,
        ) as dataset:
            dataset.write(values, 1)
            dataset.update_tags(VERTICAL_UNITS="US_survey_foot", SOURCE_DATASET="unit-test-dem")
        return path

    def test_draw_profile_samples_ground_and_returns_wgs84_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            dem_path = self._write_dem(Path(temporary))
            result = _sample_profile(
                LineString([(5, 95), (95, 5)]),
                source_crs="EPSG:2264",
                dem_path=dem_path,
                mode="draw",
                asset=None,
                requested_interval=20,
                warnings=[],
            )

        self.assertGreaterEqual(result["sample_count"], 2)
        self.assertEqual(0.0, result["samples"][0]["ground_elevation"])
        self.assertEqual(99.0, result["samples"][-1]["ground_elevation"])
        self.assertEqual("LineString", result["path"]["type"])
        self.assertEqual("unit-test-dem", result["dem_runtime"]["source_dataset"])

    def test_pipe_profile_interpolates_endpoint_inverts_and_cover(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            dem_path = self._write_dem(Path(temporary))
            result = _sample_profile(
                LineString([(5, 95), (95, 5)]),
                source_crs="EPSG:2264",
                dem_path=dem_path,
                mode="pipe",
                asset={
                    "asset_id": "P_TEST",
                    "US_ID": "S_UP",
                    "US_ASSETID": "S_ITPIPES_UP",
                    "DS_ID": "S_DOWN",
                    "DS_ASSETID": "S_ITPIPES_DOWN",
                    "US_INVERT": -10,
                    "DS_INVERT": 80,
                },
                requested_interval=20,
                warnings=[],
            )

        self.assertEqual(-10.0, result["samples"][0]["asset_elevation"])
        self.assertEqual(80.0, result["samples"][-1]["asset_elevation"])
        self.assertEqual(10.0, result["samples"][0]["cover"])
        self.assertEqual(19.0, result["samples"][-1]["cover"])
        self.assertIsNotNone(result["statistics"]["pipe_grade_percent"])
        self.assertEqual("upstream", result["endpoints"]["start"]["role"])
        self.assertEqual("S_ITPIPES_UP", result["endpoints"]["start"]["label"])
        self.assertEqual(-10.0, result["endpoints"]["start"]["elevation"])
        self.assertEqual("downstream", result["endpoints"]["end"]["role"])
        self.assertEqual("S_ITPIPES_DOWN", result["endpoints"]["end"]["label"])
        self.assertEqual(80.0, result["endpoints"]["end"]["elevation"])

    def test_drainage_profile_returns_structure_ids_without_fabricating_elevations(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            dem_path = self._write_dem(Path(temporary))
            result = _sample_profile(
                LineString([(5, 95), (95, 5)]),
                source_crs="EPSG:2264",
                dem_path=dem_path,
                mode="drainage",
                asset={
                    "asset_id": "D_TEST",
                    "US_ID": "S_UP",
                    "US_ASSETID": "S_ITPIPES_UP",
                    "DS_ID": "S_DOWN",
                    "DS_ASSETID": "S_ITPIPES_DOWN",
                    "CH_SHAPE": "Trapezoid",
                    "DEPTH": 4,
                },
                requested_interval=20,
                warnings=[],
            )

        self.assertEqual("S_ITPIPES_UP", result["endpoints"]["start"]["label"])
        self.assertEqual("S_ITPIPES_DOWN", result["endpoints"]["end"]["label"])
        self.assertIsNone(result["endpoints"]["start"]["elevation"])
        self.assertIsNone(result["endpoints"]["end"]["elevation"])
        self.assertTrue(all(sample["asset_elevation"] is None for sample in result["samples"]))
        self.assertIn("only the ground profile is shown", " ".join(result["warnings"]))

    def test_pipe_with_missing_invert_uses_itpipes_structure_ids_and_marks_profile_schematic(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            dem_path = self._write_dem(Path(temporary))
            result = _sample_profile(
                LineString([(5, 95), (95, 5)]),
                source_crs="EPSG:2264",
                dem_path=dem_path,
                mode="pipe",
                asset={
                    "asset_id": "P_MISSING_INVERT",
                    "US_ID": "LEGACY_UP",
                    "US_ASSETID": "S_ITPIPES_UP",
                    "US_INVERT": 10,
                    "DS_ID": "LEGACY_DOWN",
                    "DS_ASSETID": "S_ITPIPES_DOWN",
                    "DS_INVERT": None,
                },
                requested_interval=20,
                warnings=[],
            )

        self.assertEqual("S_ITPIPES_UP", result["endpoints"]["start"]["label"])
        self.assertEqual("S_ITPIPES_DOWN", result["endpoints"]["end"]["label"])
        self.assertTrue(all(sample["asset_elevation"] is None for sample in result["samples"]))
        self.assertIn("pipe alignment is schematic", " ".join(result["warnings"]))

    def test_itpipes_downstream_inspection_uses_source_distance_as_profile_station(self) -> None:
        result = _itpipes_profile_overlay(
            {
                "mli_id": "8",
                "ml_id": "100",
                "inspection_date": "2026-03-01T11:00:00",
                "inspection_direction": "Downstream",
                "production_asset_id": "P_100",
                "defects": [
                    {
                        "mlo_id": "80",
                        "source_distance_feet": 30.75,
                        "condition_risk": 25,
                        "observation_text": "Joint separation",
                    }
                ],
            },
            100,
        )

        self.assertEqual("ready", result["status"])
        self.assertEqual(1, result["inspection"]["inspection_direction_code"])
        self.assertEqual(30.75, result["defects"][0]["profile_distance_feet"])

    def test_itpipes_upstream_inspection_reverses_source_distance(self) -> None:
        result = _itpipes_profile_overlay(
            {
                "mli_id": "7",
                "ml_id": "100",
                "inspection_date": "2026-02-01T09:30:00",
                "inspection_direction": "Upstream",
                "production_asset_id": "P_100",
                "defects": [
                    {
                        "mlo_id": "70",
                        "source_distance_feet": 20,
                        "condition_risk": 24,
                        "observation_text": "Crack",
                    }
                ],
            },
            100,
        )

        self.assertEqual(0, result["inspection"]["inspection_direction_code"])
        self.assertEqual(80.0, result["defects"][0]["profile_distance_feet"])

    def test_itpipes_unknown_direction_keeps_defect_unlocated(self) -> None:
        result = _itpipes_profile_overlay(
            {
                "mli_id": "7",
                "ml_id": "100",
                "inspection_date": "2026-02-01T09:30:00",
                "inspection_direction": "Unknown value",
                "production_asset_id": "P_100",
                "defects": [{"mlo_id": "70", "source_distance_feet": 20, "condition_risk": 24}],
            },
            100,
        )

        self.assertIsNone(result["defects"][0]["profile_distance_feet"])
        self.assertEqual("unknown_direction", result["defects"][0]["location_status"])
        self.assertEqual(1, result["unlocated_count"])


if __name__ == "__main__":
    unittest.main()
