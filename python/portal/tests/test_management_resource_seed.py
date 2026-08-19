from __future__ import annotations

import unittest
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from portal.app.management.database import Base
from portal.app.management.models import Resource
from portal.app.management.seed import seed_resources


class ManagementResourceSeedTests(unittest.TestCase):
    def test_startup_seed_preserves_administrator_resource_flags(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:")
        Base.metadata.create_all(engine)
        metadata = {
            "resource_id": "DASAIF01",
            "resource_slug": "dashboard_aif_overview",
            "name": "AIF Overview",
            "type": "dashboard",
            "url": "/dashboard_aif_overview",
            "description": "Initial description",
            "category": "Planning",
            "icon": "chart",
            "is_active": True,
            "is_public": False,
        }

        with Session(engine) as session:
            with patch(
                "portal.app.management.seed.load_resource_metadata",
                return_value=[metadata],
            ):
                seed_resources(session)
                session.commit()

                resource = session.scalar(
                    select(Resource).where(Resource.resource_id == "DASAIF01")
                )
                self.assertIsNotNone(resource)
                self.assertEqual(resource.is_released, 0)
                resource.is_active = 0
                resource.is_public = 1
                resource.is_released = 1
                resource.released_at = "2026-08-17 12:00:00"
                session.commit()

                refreshed_metadata = {
                    **metadata,
                    "description": "Updated bundled description",
                    "is_active": True,
                    "is_public": False,
                }
                with patch(
                    "portal.app.management.seed.load_resource_metadata",
                    return_value=[refreshed_metadata],
                ):
                    seed_resources(session)
                    session.commit()

                session.refresh(resource)
                self.assertEqual(resource.description, "Updated bundled description")
                self.assertEqual(resource.is_active, 0)
                self.assertEqual(resource.is_public, 1)
                self.assertEqual(resource.is_released, 1)
                self.assertEqual(resource.released_at, "2026-08-17 12:00:00")
        engine.dispose()


if __name__ == "__main__":
    unittest.main()
