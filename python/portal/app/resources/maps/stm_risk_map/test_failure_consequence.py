from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import numpy as np
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import LineString, Point, box

from .failure_consequence import (
    _asset_wide_zoi,
    _defect,
    _display_clip_extent,
    _fill_missing_grid,
    _feature_influence,
    _influence_footprint,
    _profile_values_at,
    _structure_cover_profile,
    _structure_invert_scenario,
    _terrain_cutaway,
    parse_stationing,
)


class FailureConsequenceRulesTest(unittest.TestCase):
    def test_station_lists_and_ranges_are_parsed(self) -> None:
        self.assertEqual(parse_stationing("91, 99, 115"), [91.0, 99.0, 115.0])
        self.assertEqual(parse_stationing("Station 40-70 ft"), [40.0, 70.0])

    def test_free_text_stationing_is_not_invented(self) -> None:
        self.assertEqual(parse_stationing("Near the downstream headwall"), [])
        self.assertEqual(parse_stationing("unknown blockage 4"), [])

    def test_zoi_uses_step_300_formula(self) -> None:
        defect = _defect(
            defect_id="test",
            source="simulated",
            label="Test",
            geometry=LineString([(0, 0), (10, 0)]).interpolate(5),
            relative_depth=6.5,
            condition_risk=None,
            station=5,
            metadata={},
        )
        self.assertEqual(defect["zoi_radius_feet"], 16.0)

    def test_cutaway_grid_fills_sparse_dem_gaps(self) -> None:
        values = [10.0, None, 12.0, 14.0]
        self.assertEqual(_fill_missing_grid(values, 2, 2), [10.0, 12.0, 12.0, 14.0])

    def test_display_clip_extent_is_twice_the_asset_wide_zoi(self) -> None:
        asset = LineString([(0, 0), (300, 0)])
        zoi = asset.buffer(25)
        extent, basis = _display_clip_extent(asset, zoi)
        self.assertEqual(basis, "zoi")
        self.assertTrue(extent.covers(asset))
        self.assertTrue(extent.covers(zoi))
        self.assertAlmostEqual(extent.bounds[0], -200.0)
        self.assertAlmostEqual(extent.bounds[1], -50.0)
        self.assertAlmostEqual(extent.bounds[2], 500.0)
        self.assertAlmostEqual(extent.bounds[3], 50.0)

    def test_display_clip_extent_uses_zoi_when_it_is_larger(self) -> None:
        asset = LineString([(0, 0), (10, 0)])
        zoi = Point(5, 0).buffer(25)
        extent, basis = _display_clip_extent(asset, zoi)
        self.assertEqual(basis, "zoi")
        self.assertTrue(extent.covers(asset))
        self.assertTrue(extent.covers(zoi))
        self.assertAlmostEqual(extent.bounds[0], -45.0)
        self.assertAlmostEqual(extent.bounds[1], -50.0)
        self.assertAlmostEqual(extent.bounds[2], 55.0)
        self.assertAlmostEqual(extent.bounds[3], 50.0)

    def test_profile_values_are_interpolated_at_the_exact_station(self) -> None:
        profile = {
            "samples": [
                {"distance_feet": 0.0, "ground_elevation": 110.0, "asset_elevation": 100.0, "cover": 10.0},
                {"distance_feet": 100.0, "ground_elevation": 130.0, "asset_elevation": 90.0, "cover": 40.0},
            ]
        }
        values = _profile_values_at(profile, 25.0)
        self.assertAlmostEqual(values["ground_elevation"], 115.0)
        self.assertAlmostEqual(values["invert_elevation"], 97.5)
        self.assertAlmostEqual(values["cover"], 17.5)

    def test_pipe_asset_wide_zoi_covers_every_profile_segment(self) -> None:
        asset = LineString([(0, 0), (100, 0)])
        profile = {
            "samples": [
                {"distance_feet": 0.0, "cover": 1.0},
                {"distance_feet": 50.0, "cover": 4.0},
                {"distance_feet": 100.0, "cover": 2.0},
            ]
        }
        zoi, minimum_radius, maximum_radius = _asset_wide_zoi("pipe", asset, profile)
        self.assertTrue(zoi.covers(asset))
        self.assertEqual(minimum_radius, 11.0)
        self.assertEqual(maximum_radius, 11.0)
        self.assertAlmostEqual(zoi.bounds[0], -11.0)
        self.assertAlmostEqual(zoi.bounds[2], 111.0)

    def test_polygon_influence_reports_exact_area_and_percentage(self) -> None:
        feature = box(0, 0, 10, 10)
        result = _feature_influence(
            feature,
            box(0, 0, 5, 10),
            Point(2, 5).buffer(3),
            feature_area=100.0,
            feature_length=40.0,
        )
        self.assertTrue(result["is_influenced"])
        self.assertEqual(result["relationship"], "direct")
        self.assertEqual(result["measurement_type"], "area")
        self.assertAlmostEqual(result["influenced_area_sqft"], 50.0)
        self.assertAlmostEqual(result["influenced_percent"], 50.0)

    def test_line_influence_reports_exact_length(self) -> None:
        feature = LineString([(0, 0), (10, 0)])
        result = _feature_influence(
            feature,
            box(0, -1, 4, 1),
            Point(20, 20).buffer(3),
            feature_length=10.0,
        )
        self.assertTrue(result["is_influenced"])
        self.assertEqual(result["relationship"], "within_zoi")
        self.assertEqual(result["measurement_type"], "length")
        self.assertAlmostEqual(result["influenced_length_feet"], 4.0)
        self.assertAlmostEqual(result["influenced_percent"], 40.0)

    def test_context_feature_is_not_counted_without_active_scenario(self) -> None:
        result = _feature_influence(Point(1, 1), None, None)
        self.assertFalse(result["is_influenced"])
        self.assertEqual(result["relationship"], "context")
        self.assertIsNone(result["influenced_geometry_2264"])

    def test_overlapping_polygon_influences_are_unioned_once(self) -> None:
        footprint = _influence_footprint(
            [
                {"influenced_geometry_2264": box(0, 0, 10, 10)},
                {"influenced_geometry_2264": box(5, 0, 15, 10)},
                {"influenced_geometry_2264": LineString([(0, 5), (15, 5)])},
            ]
        )
        self.assertIsNotNone(footprint)
        assert footprint is not None
        self.assertAlmostEqual(footprint.area, 150.0)

    def test_structure_cover_uses_dem_minus_inventory_invert(self) -> None:
        with TemporaryDirectory() as temporary:
            dem_path = Path(temporary) / "mecklenburg_dem.tif"
            values = np.full((64, 64), 625.0, dtype="float32")
            with rasterio.open(
                dem_path,
                "w",
                driver="GTiff",
                width=64,
                height=64,
                count=1,
                dtype="float32",
                crs="EPSG:2264",
                transform=from_origin(0, 640, 10, 10),
            ) as dataset:
                dataset.write(values, 1)
            warnings: list[str] = []
            with patch(
                "portal.app.resources.maps.stm_risk_map.failure_consequence._resolve_dem",
                return_value=(dem_path, {"file_name": dem_path.name}),
            ):
                profile = _structure_cover_profile({"INVERT": 612.5}, Point(320, 320), warnings)
            self.assertIsNotNone(profile)
            assert profile is not None
            self.assertEqual(profile["samples"][0]["cover"], 12.5)
            scenario = _structure_invert_scenario("structure", Point(320, 320), profile)
            self.assertIsNotNone(scenario)
            assert scenario is not None
            self.assertEqual(scenario["source"], "inventory")
            self.assertEqual(scenario["zoi_radius_feet"], 28.0)
            self.assertFalse(warnings)

    def test_cutaway_uses_the_configured_analytical_dem(self) -> None:
        with TemporaryDirectory() as temporary:
            dem_path = Path(temporary) / "mecklenburg_dem.tif"
            values = np.linspace(100, 140, 64 * 64, dtype="float32").reshape((64, 64))
            with rasterio.open(
                dem_path,
                "w",
                driver="GTiff",
                width=64,
                height=64,
                count=1,
                dtype="float32",
                crs="EPSG:2264",
                transform=from_origin(0, 640, 10, 10),
            ) as dataset:
                dataset.write(values, 1)
            defect = {"geometry_2264": Point(320, 320)}
            asset = LineString([(250, 320), (390, 320)])
            analysis = {"zoi_radius_feet": 20.0}
            warnings: list[str] = []
            with patch(
                "portal.app.resources.maps.stm_risk_map.failure_consequence._resolve_dem",
                return_value=(dem_path, {"file_name": dem_path.name}),
            ):
                cutaway = _terrain_cutaway(defect, asset, analysis, warnings)
            self.assertIsNotNone(cutaway)
            assert cutaway is not None
            self.assertEqual(cutaway["dem_file"], "mecklenburg_dem.tif")
            self.assertEqual(len(cutaway["elevations"]), 72 * 72)
            self.assertEqual(cutaway["width_feet"], 360.0)
            self.assertEqual(cutaway["height_feet"], 80.0)
            self.assertTrue(cutaway["asset_geometry_2264"].length > 0)
            self.assertFalse(warnings)


if __name__ == "__main__":
    unittest.main()
