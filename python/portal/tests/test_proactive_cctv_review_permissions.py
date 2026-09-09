from __future__ import annotations

import importlib
import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from portal.runtime.transport import HTTPException
from portal.app.management.database import Base
from portal.app.management.models import Resource, ResourcePermission, Team, User
from portal.app.management.services import effective_resource_permission_types


cctv = importlib.import_module(
    "portal.app.resources.reports.proactive_team_cctv_review.router"
)
amteam = importlib.import_module("portal.app.dashboards.amteam.router")


def user(employee_id: str, team_id: int | None = None, *, admin: bool = False) -> User:
    return User(
        username=f"user-{employee_id}",
        first_name="Portal",
        last_name=employee_id,
        email=f"{employee_id}@example.com",
        employee_id=employee_id,
        password_hash="test",
        team_id=team_id,
        is_active=1,
        is_admin=1 if admin else 0,
        is_system_admin=0,
    )


class ProactiveCctvPermissionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.session = Session(self.engine)

        self.asset_team = Team(name="Asset Management Team", is_active=1)
        self.planning_team = Team(name="Planning Team", is_active=1)
        self.session.add_all([self.asset_team, self.planning_team])
        self.session.flush()
        self.proactive_team = Team(
            name="Proactive Team",
            parent_team_id=self.asset_team.id,
            is_active=1,
        )
        self.session.add(self.proactive_team)
        self.session.flush()

        self.asset_user = user("100001", self.asset_team.id)
        self.proactive_user = user("100002", self.proactive_team.id)
        self.planning_user = user("100003", self.planning_team.id)
        self.session.add_all([self.asset_user, self.proactive_user, self.planning_user])
        self.session.flush()

        self.resource = Resource(
            resource_id="RPT5W1C0",
            resource_key="proactive_team_cctv_review",
            name="Proactive Team CCTV Review",
            resource_type="report",
            url="/report_proactive_team_cctv_review",
            is_public=0,
            is_active=1,
            is_released=1,
        )
        self.session.add(self.resource)
        self.session.commit()

    def tearDown(self) -> None:
        self.session.close()
        self.engine.dispose()

    def grant(self, subject: User, mask: int) -> None:
        self.session.add(
            ResourcePermission(
                resource_id=self.resource.resource_id,
                user_id=subject.id,
                permission_level=mask,
            )
        )
        self.session.commit()

    def test_action_permissions_imply_view_and_manage_expands_actions(self) -> None:
        self.grant(self.proactive_user, 32)

        permissions = effective_resource_permission_types(
            self.session, self.proactive_user, self.resource
        )

        self.assertEqual(
            permissions,
            {"view", "create", "edit", "review", "delete", "manage"},
        )
        self.assertNotIn("admin", permissions)

    def test_legacy_report_uses_creator_team_as_scope_fallback(self) -> None:
        report = {
            "created_by_user_id": self.proactive_user.id,
            "status": "pending",
        }

        self.assertEqual(cctv._report_team_id(self.session, report), self.proactive_team.id)

    def test_report_capabilities_follow_permission_scope_and_status(self) -> None:
        pending = {
            "created_by_user_id": self.proactive_user.id,
            "created_by_team_id": self.proactive_team.id,
            "status": "pending",
        }
        ready = {**pending, "status": "ready_to_review"}
        completed = {**pending, "status": "completed"}

        author = cctv._report_capabilities(
            self.session,
            self.proactive_user,
            pending,
            {"view", "create", "edit"},
        )
        reviewer = cctv._report_capabilities(
            self.session,
            self.asset_user,
            ready,
            {"view", "review"},
        )
        outside = cctv._report_capabilities(
            self.session,
            self.planning_user,
            pending,
            {"view", "edit", "review", "delete"},
        )
        reopened = cctv._report_capabilities(
            self.session,
            self.planning_user,
            completed,
            {"view", "review"},
        )

        self.assertTrue(author["can_edit"])
        self.assertTrue(author["can_submit"])
        self.assertFalse(author["can_complete"])
        self.assertTrue(reviewer["can_return_to_edit"])
        self.assertTrue(reviewer["can_complete"])
        self.assertTrue(outside["can_edit"])
        self.assertTrue(outside["can_delete"])
        self.assertTrue(reopened["can_reopen"])
        self.assertFalse(reopened["can_complete"])

    def test_amteam_mutations_require_create_or_edit_permission(self) -> None:
        self.grant(self.proactive_user, 1)

        with self.assertRaises(HTTPException) as context:
            amteam._require_cctv_review_permission(
                self.session, self.proactive_user, "create", "edit"
            )

        self.assertEqual(context.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
