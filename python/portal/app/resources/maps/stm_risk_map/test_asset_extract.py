from __future__ import annotations

import unittest

from portal.runtime.transport import HTTPException

from .asset_extract import (
    PREVIEW_LIMIT,
    _apply_related_mode,
    _compiled_risk_rules,
    _filter_parts,
    _matches_risk_rules,
    _preview_sample,
    _qualified_table,
    _selection_area,
)


class AssetExtractTests(unittest.TestCase):
    def test_qualified_boundary_table_supports_configured_schema(self) -> None:
        self.assertEqual('"geo"."WorkZones"', _qualified_table("WorkZones", "geo"))
        self.assertEqual('"Culverts_evw"', _qualified_table("Culverts_evw"))

    def test_preview_sample_represents_every_selected_asset_type(self) -> None:
        rows = [
            *({"asset_type": "structure", "asset_id": f"S_{index}"} for index in range(PREVIEW_LIMIT + 25)),
            {"asset_type": "pipe", "asset_id": "P_1"},
            {"asset_type": "channel", "asset_id": "D_1"},
        ]

        sample = _preview_sample(rows)

        self.assertEqual(len(sample), PREVIEW_LIMIT)
        self.assertEqual({row["asset_type"] for row in sample}, {"structure", "pipe", "channel"})

    def test_selection_area_accepts_polygon_and_projects_it(self) -> None:
        geometry, state_plane_wkt = _selection_area({
            "area": {
                "type": "Polygon",
                "coordinates": [[[-80.85, 35.20], [-80.84, 35.20], [-80.84, 35.21], [-80.85, 35.21], [-80.85, 35.20]]],
            }
        })
        self.assertEqual("Polygon", geometry["type"])
        self.assertTrue(state_plane_wkt.startswith("POLYGON"))

    def test_selection_area_rejects_non_polygon(self) -> None:
        with self.assertRaises(HTTPException):
            _selection_area({"area": {"type": "Point", "coordinates": [-80.84, 35.22]}})

    def test_filter_parts_validates_schema_and_parameterizes_values(self) -> None:
        fields = [
            {"name": "MATERIAL", "label": "Material", "type": "text", "filterable": True},
            {"name": "DIAMETER", "label": "Diameter", "type": "number", "filterable": True},
        ]
        parts, values = _filter_parts([
            {"field": "MATERIAL", "operator": "contains", "value": "RCP%"},
            {"field": "DIAMETER", "operator": "gte", "value": "24"},
        ], fields)
        self.assertEqual(2, len(parts))
        self.assertEqual(["%rcp\\%%", 24.0], values)
        self.assertNotIn("RCP", " ".join(parts))

    def test_related_risk_rules_are_numeric_and_use_standardized_scores(self) -> None:
        payload = {"filters": {"pipe": [{"field": "__condition_risk", "operator": "gte", "value": "15"}]}}

        rules = _compiled_risk_rules(payload, "pipe")

        self.assertEqual([("condition_risk", "gte", 15.0)], rules)
        self.assertTrue(_matches_risk_rules({"condition_risk": 15.0}, rules))
        self.assertFalse(_matches_risk_rules({"condition_risk": 14.9}, rules))

    def test_most_recent_mode_keeps_all_defects_from_newest_itpipes_inspection(self) -> None:
        related = {
            "service_requests": [
                {"asset_type": "pipe", "asset_id": "P_1", "record_id": "1", "event_date": "2025-01-01"},
                {"asset_type": "pipe", "asset_id": "P_1", "record_id": "2", "event_date": "2026-01-01"},
            ],
            "investigations": [],
            "inspections": [],
            "work_orders": [],
            "itpipes_defects": [
                {"asset_id": "P_1", "mli_id": "10", "mlo_id": "100", "inspection_date": "2025-02-01"},
                {"asset_id": "P_1", "mli_id": "9", "mlo_id": "150", "inspection_date": "2026-02-01"},
                {"asset_id": "P_1", "mli_id": "20", "mlo_id": "200", "inspection_date": "2026-02-01"},
                {"asset_id": "P_1", "mli_id": "20", "mlo_id": "201", "inspection_date": "2026-02-01"},
            ],
            "pipe_risk": [{"asset_id": "P_1", "risk": 20}],
        }

        result = _apply_related_mode(related, "most_recent")

        self.assertEqual(["2"], [row["record_id"] for row in result["service_requests"]])
        self.assertEqual({"200", "201"}, {row["mlo_id"] for row in result["itpipes_defects"]})
        self.assertEqual(1, len(result["pipe_risk"]))


if __name__ == "__main__":
    unittest.main()
