from __future__ import annotations

import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from portal.app.sync import (
    CorruptArtifact,
    DataCoordinator,
    Identity,
    Mutation,
    RevisionChanged,
    bootstrap_shared_store,
)
from portal.app.sync import membership, snapshot
from portal.app.sync.errors import SnapshotRequired
from portal.app.sync.local_store import LocalStore


class DataCoordinatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="portal-sync-test-")
        self.root = Path(self.temporary.name)
        self.network = self.root / "share"
        self.alice = Identity("user-alice", "1001", "alice@example.gov")
        self.bob = Identity("user-bob", "1002", "bob@example.gov")
        bootstrap_shared_store(self.network, [self.alice, self.bob])
        self.alice_coordinator = DataCoordinator(
            identity=self.alice,
            database_path=self.root / "alice" / "stormwater.db",
            network_root=self.network,
        )
        self.bob_coordinator = DataCoordinator(
            identity=self.bob,
            database_path=self.root / "bob" / "stormwater.db",
            network_root=self.network,
        )
        self.alice_coordinator.initialize()
        self.bob_coordinator.initialize()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_commit_pull_and_update_converge(self) -> None:
        inserted = self.alice_coordinator.commit(
            [
                Mutation(
                    entity_type="inspection_review",
                    entity_id="review-1",
                    operation_type="insert_entity",
                    base_record_revision=None,
                    values={"status": "pending", "score": 3},
                )
            ]
        )
        self.bob_coordinator.sync()
        bob_entity = self.bob_coordinator.get_entity("inspection_review", "review-1")
        self.assertEqual(bob_entity["values"]["status"], "pending")
        self.assertEqual(inserted.first_seq, 1)

        self.bob_coordinator.commit(
            [
                Mutation(
                    entity_type="inspection_review",
                    entity_id="review-1",
                    operation_type="update_fields",
                    base_record_revision=str(bob_entity["record_revision"]),
                    values={"status": "ready_to_review"},
                )
            ]
        )
        self.alice_coordinator.sync()
        alice_entity = self.alice_coordinator.get_entity("inspection_review", "review-1")
        self.assertEqual(alice_entity["values"]["status"], "ready_to_review")

    def test_read_syncs_when_the_refresh_interval_has_elapsed(self) -> None:
        self.alice_coordinator.commit(
            [
                Mutation(
                    entity_type="inspection_review",
                    entity_id="read-refresh-1",
                    operation_type="insert_entity",
                    base_record_revision=None,
                    values={"status": "pending"},
                )
            ]
        )
        self.bob_coordinator._last_sync_monotonic = 0.0

        entity = self.bob_coordinator.get_entity("inspection_review", "read-refresh-1")

        self.assertIsNotNone(entity)
        self.assertEqual(entity["values"]["status"], "pending")

    def test_empty_unverified_database_is_replaced_from_the_shared_snapshot(self) -> None:
        database_path = self.root / "legacy" / "stormwater.db"
        LocalStore(database_path).initialize()
        coordinator = DataCoordinator(
            identity=self.alice,
            database_path=database_path,
            network_root=self.network,
        )

        coordinator.initialize()

        self.assertTrue(coordinator.store.installed_snapshot()["installed_snapshot_id"])
        archived = list((database_path.parent / "recovery").glob("stormwater.unverified-*.db"))
        self.assertEqual(len(archived), 1)

    def test_unverified_database_with_business_data_is_not_replaced(self) -> None:
        database_path = self.root / "unsafe" / "stormwater.db"
        store = LocalStore(database_path)
        store.initialize()
        with store.transaction() as connection:
            connection.execute(
                """
                INSERT INTO sw_sync_entity(
                    entity_type, entity_id, body_json, record_revision, deleted, conflict_state
                ) VALUES ('report', 'legacy-report', '{}', 'legacy', 0, 'none')
                """
            )
        coordinator = DataCoordinator(
            identity=self.alice,
            database_path=database_path,
            network_root=self.network,
        )

        with self.assertRaises(SnapshotRequired):
            coordinator.initialize()

        self.assertTrue(database_path.exists())
        self.assertFalse((database_path.parent / "recovery").exists())

    def test_stale_revision_is_rejected_after_authoritative_barrier(self) -> None:
        self.alice_coordinator.commit(
            [
                Mutation(
                    entity_type="asset_note",
                    entity_id="note-1",
                    operation_type="insert_entity",
                    base_record_revision=None,
                    values={"memo": "initial"},
                )
            ]
        )
        self.bob_coordinator.sync()
        stale = self.bob_coordinator.get_entity("asset_note", "note-1")
        current = self.alice_coordinator.get_entity("asset_note", "note-1")
        self.alice_coordinator.commit(
            [
                Mutation(
                    entity_type="asset_note",
                    entity_id="note-1",
                    operation_type="update_fields",
                    base_record_revision=str(current["record_revision"]),
                    values={"memo": "alice"},
                )
            ]
        )
        with self.assertRaises(RevisionChanged):
            self.bob_coordinator.commit(
                [
                    Mutation(
                        entity_type="asset_note",
                        entity_id="note-1",
                        operation_type="update_fields",
                        base_record_revision=str(stale["record_revision"]),
                        values={"memo": "bob stale"},
                    )
                ]
            )

    def test_committed_head_recovers_interrupted_local_apply(self) -> None:
        original_apply = self.alice_coordinator.store.apply_package

        def interrupted_apply(**_kwargs):
            raise RuntimeError("simulated local apply interruption")

        self.alice_coordinator.store.apply_package = interrupted_apply  # type: ignore[method-assign]
        with self.assertRaisesRegex(RuntimeError, "simulated"):
            self.alice_coordinator.commit(
                [
                    Mutation(
                        entity_type="inspection_review",
                        entity_id="recovery-1",
                        operation_type="insert_entity",
                        base_record_revision=None,
                        values={"status": "pending"},
                    )
                ]
            )
        self.alice_coordinator.store.apply_package = original_apply  # type: ignore[method-assign]
        self.alice_coordinator.recover()
        entity = self.alice_coordinator.get_entity("inspection_review", "recovery-1")
        self.assertEqual(entity["values"]["status"], "pending")
        self.assertEqual(self.alice_coordinator.store.outbox_rows()[0]["state"], "applied")

    def test_unreachable_operation_file_is_ignored(self) -> None:
        self.alice_coordinator.commit(
            [
                Mutation(
                    entity_type="inspection_review",
                    entity_id="visible-1",
                    operation_type="insert_entity",
                    base_record_revision=None,
                    values={"status": "pending"},
                )
            ]
        )
        actor_id = str(self.alice_coordinator.actor_id)
        orphan = (
            self.alice_coordinator.paths.actor_root(self.alice, actor_id)
            / "operations"
            / "orphan.opdb"
        )
        orphan.parent.mkdir(parents=True, exist_ok=True)
        orphan.write_bytes(b"not a committed package")

        result = self.bob_coordinator.sync()

        self.assertEqual(result.get(actor_id), 1)
        self.assertEqual(self.bob_coordinator.store.cursor(actor_id), 1)
        self.assertIsNotNone(
            self.bob_coordinator.get_entity("inspection_review", "visible-1")
        )

    def test_committed_package_hash_mismatch_is_rejected(self) -> None:
        self.alice_coordinator.commit(
            [
                Mutation(
                    entity_type="inspection_review",
                    entity_id="tamper-1",
                    operation_type="insert_entity",
                    base_record_revision=None,
                    values={"status": "pending"},
                )
            ]
        )
        head = self.alice_coordinator._read_own_head()
        self.assertIsNotNone(head.package)
        package_path = (
            self.alice_coordinator.paths.actor_root(
                self.alice, str(self.alice_coordinator.actor_id)
            )
            / str(head.package.relative_path)
        )
        with package_path.open("ab") as stream:
            stream.write(b"tampered")

        with self.assertRaises(CorruptArtifact):
            self.bob_coordinator.sync()

    def test_membership_and_snapshot_runtime_metadata_are_diagnostic(self) -> None:
        membership_runtime = membership.PYTHON_RUNTIME_VERSION
        snapshot_runtime = snapshot.PYTHON_RUNTIME_VERSION
        try:
            membership.PYTHON_RUNTIME_VERSION = "99.99.99"
            snapshot.PYTHON_RUNTIME_VERSION = "99.99.99"
            result = self.alice_coordinator.initialize()
        finally:
            membership.PYTHON_RUNTIME_VERSION = membership_runtime
            snapshot.PYTHON_RUNTIME_VERSION = snapshot_runtime

        self.assertEqual(result["user_id"], self.alice.user_id)

    def test_concurrent_updates_allow_only_one_revision(self) -> None:
        self.alice_coordinator.commit(
            [
                Mutation(
                    entity_type="inspection_review",
                    entity_id="race-1",
                    operation_type="insert_entity",
                    base_record_revision=None,
                    values={"status": "pending"},
                )
            ]
        )
        self.bob_coordinator.sync()
        base_revision = str(
            self.alice_coordinator.get_entity("inspection_review", "race-1")[
                "record_revision"
            ]
        )
        barrier = threading.Barrier(2)

        def update(coordinator: DataCoordinator, status: str) -> str:
            barrier.wait(timeout=5)
            try:
                coordinator.commit(
                    [
                        Mutation(
                            entity_type="inspection_review",
                            entity_id="race-1",
                            operation_type="update_fields",
                            base_record_revision=base_revision,
                            values={"status": status},
                        )
                    ]
                )
                return "committed"
            except RevisionChanged:
                return "stale"

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(update, self.alice_coordinator, "alice"),
                executor.submit(update, self.bob_coordinator, "bob"),
            ]
            results = [future.result() for future in futures]
        self.assertEqual(sorted(results), ["committed", "stale"])


if __name__ == "__main__":
    unittest.main()
