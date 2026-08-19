from __future__ import annotations

import unittest
import importlib
from types import SimpleNamespace
from unittest.mock import patch

from portal.runtime.transport import HTTPException


planning = importlib.import_module("portal.app.dashboards.planning.router")


class _ScalarValues:
    def __init__(self, values: list[str]) -> None:
        self._values = values

    def all(self) -> list[str]:
        return self._values


class _PlanningDb:
    def __init__(self, team_names: list[str] | None = None) -> None:
        self.team_names = team_names or []

    def scalar(self, _statement):
        return SimpleNamespace(is_active=1)

    def scalars(self, _statement) -> _ScalarValues:
        return _ScalarValues(self.team_names)


class PendingAifPermissionTests(unittest.TestCase):
    def test_manage_permission_can_see_every_team(self) -> None:
        with patch.object(
            planning,
            "effective_resource_permission",
            return_value={"permission_types": ["manage"]},
        ):
            scope = planning.pending_aif_authorized_team_names(
                _PlanningDb(),
                SimpleNamespace(team_id=1),
            )

        self.assertIsNone(scope)

    def test_view_permission_uses_current_team_and_descendants(self) -> None:
        database = _PlanningDb(["Asset Management Team", "Critical Team", "Proactive Team"])
        with (
            patch.object(
                planning,
                "effective_resource_permission",
                return_value={"permission_types": ["view"]},
            ),
            patch.object(planning, "team_descendant_ids", return_value=[1, 2, 6]) as descendants,
        ):
            scope = planning.pending_aif_authorized_team_names(
                database,
                SimpleNamespace(team_id=1),
            )

        descendants.assert_called_once_with(database, [1])
        self.assertEqual(
            scope,
            {"Asset Management Team", "Critical Team", "Proactive Team"},
        )

    def test_view_scope_hides_unmapped_and_other_team_records(self) -> None:
        records = [
            {"inspection_id": 1, "team": "Asset Management Team"},
            {"inspection_id": 2, "team": "Critical Team"},
            {"inspection_id": 3, "team": "Planning Team"},
            {"inspection_id": 4, "team": None},
        ]

        scoped = planning.scope_pending_aif_records(
            records,
            {"Asset Management Team", "Critical Team", "Proactive Team"},
        )

        self.assertEqual([record["inspection_id"] for record in scoped], [1, 2])

    def test_user_without_view_or_manage_permission_is_rejected(self) -> None:
        with patch.object(
            planning,
            "effective_resource_permission",
            return_value={"permission_types": ["review"]},
        ):
            with self.assertRaises(HTTPException) as context:
                planning.pending_aif_authorized_team_names(
                    _PlanningDb(),
                    SimpleNamespace(team_id=1),
                )

        self.assertEqual(context.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
