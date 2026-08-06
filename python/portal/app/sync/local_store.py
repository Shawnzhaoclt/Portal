from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Iterator, Mapping, Sequence

from .errors import ProtocolViolation, RevisionChanged
from .models import ActorHead, Identity, Mutation, Operation, canonical_json, utc_now
from .physical_entities import (
    count_all_physical_entities,
    delete_physical_entity,
    dependency_order,
    get_physical_entity,
    initialize_physical_schema,
    is_managed_entity_type,
    materialize_physical_entity,
    physical_spec,
    query_physical_entities,
)


SCHEMA_SQL = """
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS sw_sync_actor (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    actor_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    employee_number TEXT NOT NULL,
    next_actor_seq INTEGER NOT NULL CHECK (next_actor_seq >= 1),
    head_generation INTEGER NOT NULL DEFAULT 0,
    head_package_id TEXT,
    created_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sw_sync_install_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    installed_snapshot_id TEXT,
    installed_snapshot_sha256 TEXT,
    installed_snapshot_epoch_id TEXT,
    installed_at_utc TEXT,
    last_successful_sync_at_utc TEXT,
    last_error_code TEXT
);

CREATE TABLE IF NOT EXISTS sw_sync_cursor (
    source_actor_id TEXT PRIMARY KEY,
    highest_downloaded_seq INTEGER NOT NULL DEFAULT 0,
    highest_terminal_seq INTEGER NOT NULL DEFAULT 0,
    last_package_id TEXT,
    updated_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sw_sync_observed_head (
    source_actor_id TEXT PRIMARY KEY,
    generation INTEGER NOT NULL,
    highest_published_seq INTEGER NOT NULL,
    package_id TEXT,
    package_sha256 TEXT,
    observed_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sw_sync_received_package (
    package_id TEXT PRIMARY KEY,
    source_actor_id TEXT NOT NULL,
    first_seq INTEGER NOT NULL,
    last_seq INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    state TEXT NOT NULL,
    received_at_utc TEXT NOT NULL,
    UNIQUE(source_actor_id, first_seq, last_seq)
);

CREATE TABLE IF NOT EXISTS sw_sync_operation_log (
    operation_id TEXT PRIMARY KEY,
    tx_id TEXT NOT NULL,
    tx_index INTEGER NOT NULL,
    tx_count INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    actor_seq INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    operation_type TEXT NOT NULL,
    base_record_revision TEXT,
    output_record_revision TEXT NOT NULL,
    values_json TEXT NOT NULL,
    geometry BLOB,
    created_at_utc TEXT NOT NULL,
    terminal_result TEXT NOT NULL DEFAULT 'received',
    UNIQUE(actor_id, actor_seq)
);

CREATE INDEX IF NOT EXISTS sw_sync_operation_entity
ON sw_sync_operation_log(entity_type, entity_id, actor_id, actor_seq);

CREATE TABLE IF NOT EXISTS sw_sync_entity_seed (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    base_record_revision TEXT,
    body_json TEXT NOT NULL,
    geometry BLOB,
    deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS sw_sync_entity (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    body_json TEXT NOT NULL,
    geometry BLOB,
    record_revision TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    conflict_state TEXT NOT NULL DEFAULT 'none',
    selected_operation_id TEXT,
    PRIMARY KEY(entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS sw_sync_conflict (
    conflict_id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    base_record_revision TEXT,
    candidate_operation_ids_json TEXT NOT NULL,
    selected_operation_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open',
    detected_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sw_sync_conflict_entity
ON sw_sync_conflict(state, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS sw_sync_outbox_transaction (
    tx_id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    first_seq INTEGER NOT NULL,
    last_seq INTEGER NOT NULL,
    state TEXT NOT NULL,
    package_id TEXT,
    package_path TEXT,
    error_code TEXT,
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sw_sync_applied_operation (
    operation_id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    actor_seq INTEGER NOT NULL,
    tx_id TEXT NOT NULL,
    result TEXT NOT NULL,
    applied_at_utc TEXT NOT NULL
);
"""


class LocalStore:
    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path

    def connect(self) -> sqlite3.Connection:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.database_path, timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA busy_timeout=5000")
        return connection

    def initialize(self) -> None:
        with closing(self.connect()) as connection:
            connection.executescript(SCHEMA_SQL)
            initialize_physical_schema(connection)
            connection.execute(
                "INSERT OR IGNORE INTO sw_sync_install_state(singleton) VALUES (1)"
            )

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self.connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def ensure_actor(self, identity: Identity) -> str:
        self.initialize()
        with self.transaction() as connection:
            row = connection.execute("SELECT * FROM sw_sync_actor WHERE singleton=1").fetchone()
            if row:
                if row["user_id"] != identity.user_id or row["employee_number"] != identity.employee_number:
                    raise ProtocolViolation(
                        "The local synchronization actor belongs to a different user."
                    )
                return str(row["actor_id"])
            actor_id = str(uuid.uuid4())
            connection.execute(
                """
                INSERT INTO sw_sync_actor(
                    singleton, actor_id, user_id, employee_number, next_actor_seq, created_at_utc
                ) VALUES (1, ?, ?, ?, 1, ?)
                """,
                (actor_id, identity.user_id, identity.employee_number, utc_now()),
            )
            return actor_id

    def record_snapshot_install(
        self,
        *,
        snapshot_id: str,
        snapshot_hash: str,
        snapshot_epoch_id: str,
        coverage: dict[str, int],
    ) -> None:
        self.initialize()
        now = utc_now()
        with self.transaction() as connection:
            connection.execute(
                """
                UPDATE sw_sync_install_state
                SET installed_snapshot_id=?, installed_snapshot_sha256=?,
                    installed_snapshot_epoch_id=?, installed_at_utc=?,
                    last_successful_sync_at_utc=?
                WHERE singleton=1
                """,
                (snapshot_id, snapshot_hash, snapshot_epoch_id, now, now),
            )
            for actor_id, actor_seq in coverage.items():
                connection.execute(
                    """
                    INSERT INTO sw_sync_cursor(
                        source_actor_id, highest_downloaded_seq, highest_terminal_seq,
                        updated_at_utc
                    ) VALUES (?, ?, ?, ?)
                    ON CONFLICT(source_actor_id) DO UPDATE SET
                        highest_downloaded_seq=MAX(highest_downloaded_seq, excluded.highest_downloaded_seq),
                        highest_terminal_seq=MAX(highest_terminal_seq, excluded.highest_terminal_seq),
                        updated_at_utc=excluded.updated_at_utc
                    """,
                    (actor_id, actor_seq, actor_seq, now),
                )

    def installed_snapshot(self) -> dict[str, object]:
        self.initialize()
        with closing(self.connect()) as connection:
            row = connection.execute(
                "SELECT * FROM sw_sync_install_state WHERE singleton=1"
            ).fetchone()
            return dict(row) if row else {}

    def has_unverified_business_state(self) -> bool:
        """Return whether a baseline-less database contains formal business state.

        A database that only contains coordinator schema is safe to replace from the
        shared snapshot.  Any entity or non-terminal outbox row must be preserved so
        an administrator can migrate it deliberately instead of losing a user save.
        """
        self.initialize()
        with closing(self.connect()) as connection:
            generic_entities = int(
                connection.execute("SELECT COUNT(*) FROM sw_sync_entity").fetchone()[0]
            )
            physical_entities = count_all_physical_entities(connection)
            pending = int(
                connection.execute(
                    """
                    SELECT COUNT(*)
                    FROM sw_sync_outbox_transaction
                    WHERE state NOT IN ('applied', 'voided')
                    """
                ).fetchone()[0]
            )
        return generic_entities > 0 or physical_entities > 0 or pending > 0

    def has_pending_outbox(self) -> bool:
        """Return whether this device has work not proven present in a snapshot.

        A workstation may replace a local replica only when its formal outbox is
        terminal.  This is intentionally conservative: a published package is
        still retained until the client has synchronized it and installed a
        snapshot that explicitly covers it.
        """
        self.initialize()
        with closing(self.connect()) as connection:
            row = connection.execute(
                """
                SELECT COUNT(*)
                FROM sw_sync_outbox_transaction
                WHERE state NOT IN ('applied', 'voided')
                """
            ).fetchone()
        return bool(row and int(row[0]))

    def outbox_rows(self, states: Sequence[str] | None = None) -> list[dict[str, object]]:
        self.initialize()
        with closing(self.connect()) as connection:
            if states:
                placeholders = ",".join("?" for _ in states)
                rows = connection.execute(
                    f"SELECT * FROM sw_sync_outbox_transaction WHERE state IN ({placeholders})",
                    tuple(states),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT * FROM sw_sync_outbox_transaction ORDER BY created_at_utc"
                ).fetchall()
            return [dict(row) for row in rows]

    def actor_row(self) -> sqlite3.Row:
        with closing(self.connect()) as connection:
            row = connection.execute("SELECT * FROM sw_sync_actor WHERE singleton=1").fetchone()
            if not row:
                raise ProtocolViolation("Local synchronization actor has not been initialized.")
            return row

    def align_next_actor_seq(self, actor_id: str, next_actor_seq: int) -> None:
        if next_actor_seq < 1:
            raise ProtocolViolation("The next actor sequence must be positive.")
        with self.transaction() as connection:
            connection.execute(
                "UPDATE sw_sync_actor SET next_actor_seq=? WHERE actor_id=?",
                (next_actor_seq, actor_id),
            )

    def cursor(self, actor_id: str) -> int:
        with closing(self.connect()) as connection:
            row = connection.execute(
                "SELECT highest_terminal_seq FROM sw_sync_cursor WHERE source_actor_id=?",
                (actor_id,),
            ).fetchone()
            return int(row[0]) if row else 0

    def observed_head(self, actor_id: str) -> dict[str, object] | None:
        with closing(self.connect()) as connection:
            row = connection.execute(
                "SELECT * FROM sw_sync_observed_head WHERE source_actor_id=?",
                (actor_id,),
            ).fetchone()
            return dict(row) if row else None

    def record_observed_head(self, head: ActorHead) -> None:
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO sw_sync_observed_head(
                    source_actor_id, generation, highest_published_seq,
                    package_id, package_sha256, observed_at_utc
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_actor_id) DO UPDATE SET
                    generation=excluded.generation,
                    highest_published_seq=excluded.highest_published_seq,
                    package_id=excluded.package_id,
                    package_sha256=excluded.package_sha256,
                    observed_at_utc=excluded.observed_at_utc
                """,
                (
                    head.actor_id,
                    head.generation,
                    head.highest_published_seq,
                    head.package.package_id if head.package else None,
                    head.package.sha256 if head.package else None,
                    utc_now(),
                ),
            )

    def current_revision(self, entity_type: str, entity_id: str) -> str | None:
        with closing(self.connect()) as connection:
            spec = physical_spec(entity_type)
            if spec:
                row = connection.execute(
                    f'SELECT record_revision FROM "{spec.table}" WHERE global_id=?',
                    (entity_id,),
                ).fetchone()
                return str(row[0]) if row else None
            self._require_registered_entity_type(entity_type)
            row = connection.execute(
                "SELECT record_revision FROM sw_sync_entity WHERE entity_type=? AND entity_id=?",
                (entity_type, entity_id),
            ).fetchone()
            return str(row[0]) if row else None

    def get_entity(self, entity_type: str, entity_id: str) -> dict[str, object] | None:
        with closing(self.connect()) as connection:
            if physical_spec(entity_type):
                return get_physical_entity(connection, entity_type, entity_id)
            self._require_registered_entity_type(entity_type)
            row = connection.execute(
                "SELECT * FROM sw_sync_entity WHERE entity_type=? AND entity_id=?",
                (entity_type, entity_id),
            ).fetchone()
            if not row:
                return None
            return {
                "entity_type": row["entity_type"],
                "entity_id": row["entity_id"],
                "values": json.loads(row["body_json"]),
                "geometry": row["geometry"],
                "record_revision": row["record_revision"],
                "deleted": bool(row["deleted"]),
                "conflict_state": row["conflict_state"],
            }

    def list_entities(self, entity_type: str) -> list[dict[str, object]]:
        """Return the current materialized entities for a synchronized resource."""
        with closing(self.connect()) as connection:
            if physical_spec(entity_type):
                return query_physical_entities(connection, entity_type)
            self._require_registered_entity_type(entity_type)
            rows = connection.execute(
                """
                SELECT entity_type, entity_id, body_json, geometry, record_revision, deleted, conflict_state
                FROM sw_sync_entity
                WHERE entity_type=? AND deleted=0
                ORDER BY entity_id
                """,
                (entity_type,),
            ).fetchall()
        return [
            {
                "entity_type": row["entity_type"],
                "entity_id": row["entity_id"],
                "values": json.loads(row["body_json"]),
                "geometry": row["geometry"],
                "record_revision": row["record_revision"],
                "deleted": bool(row["deleted"]),
                "conflict_state": row["conflict_state"],
            }
            for row in rows
        ]

    def query_entities(
        self,
        entity_type: str,
        *,
        filters: Mapping[str, object] | None = None,
        order_by: Sequence[tuple[str, bool]] | None = None,
        limit: int | None = None,
        offset: int = 0,
        include_deleted: bool = False,
    ) -> list[dict[str, object]]:
        """Query a registered physical entity without loading its full table."""
        self._require_registered_entity_type(entity_type)
        if physical_spec(entity_type) is None:
            raise ProtocolViolation(
                f"Entity type {entity_type} does not have a registered physical table."
            )
        with closing(self.connect()) as connection:
            return query_physical_entities(
                connection,
                entity_type,
                filters=filters,
                order_by=order_by,
                limit=limit,
                offset=offset,
                include_deleted=include_deleted,
            )

    def count_entities(
        self,
        entity_type: str,
        *,
        filters: Mapping[str, object] | None = None,
        include_deleted: bool = False,
    ) -> int:
        """Count registered physical rows using SQL-side filtering."""
        self._require_registered_entity_type(entity_type)
        if physical_spec(entity_type) is None:
            raise ProtocolViolation(
                f"Entity type {entity_type} does not have a registered physical table."
            )
        with closing(self.connect()) as connection:
            return count_physical_entities(
                connection,
                entity_type,
                filters=filters,
                include_deleted=include_deleted,
            )

    def validate_revisions(self, mutations: Sequence[Mutation]) -> None:
        for mutation in mutations:
            self._require_registered_entity_type(mutation.entity_type)
            current = self.current_revision(mutation.entity_type, mutation.entity_id)
            expected = mutation.base_record_revision
            if mutation.operation_type == "insert_entity":
                if current is not None or expected is not None:
                    raise RevisionChanged(
                        f"The record {mutation.entity_type}/{mutation.entity_id} already exists."
                    )
            elif current != expected:
                raise RevisionChanged(
                    f"The record {mutation.entity_type}/{mutation.entity_id} changed before save.",
                    details={"expected": expected, "current": current},
                )

    def prepare_operations(
        self,
        identity: Identity,
        actor_id: str,
        mutations: Sequence[Mutation],
    ) -> tuple[str, list[Operation]]:
        if not mutations:
            raise ProtocolViolation("A formal save must contain at least one mutation.")
        tx_id = str(uuid.uuid4())
        with self.transaction() as connection:
            actor = connection.execute(
                "SELECT next_actor_seq FROM sw_sync_actor WHERE actor_id=?", (actor_id,)
            ).fetchone()
            if not actor:
                raise ProtocolViolation("Local actor disappeared during save preparation.")
            first_seq = int(actor[0])
            operations = [
                Operation.from_mutation(
                    mutation,
                    tx_id=tx_id,
                    tx_index=index,
                    tx_count=len(mutations),
                    actor_id=actor_id,
                    actor_seq=first_seq + index,
                    user_id=identity.user_id,
                )
                for index, mutation in enumerate(mutations)
            ]
            last_seq = operations[-1].actor_seq
            now = utc_now()
            connection.execute(
                "UPDATE sw_sync_actor SET next_actor_seq=? WHERE actor_id=?",
                (last_seq + 1, actor_id),
            )
            connection.execute(
                """
                INSERT INTO sw_sync_outbox_transaction(
                    tx_id, actor_id, first_seq, last_seq, state, created_at_utc, updated_at_utc
                ) VALUES (?, ?, ?, ?, 'prepared', ?, ?)
                """,
                (tx_id, actor_id, first_seq, last_seq, now, now),
            )
        return tx_id, operations

    def mark_outbox(
        self,
        tx_id: str,
        state: str,
        *,
        package_id: str | None = None,
        package_path: str | None = None,
        error_code: str | None = None,
    ) -> None:
        with self.transaction() as connection:
            connection.execute(
                """
                UPDATE sw_sync_outbox_transaction
                SET state=?, package_id=COALESCE(?, package_id),
                    package_path=COALESCE(?, package_path), error_code=?, updated_at_utc=?
                WHERE tx_id=?
                """,
                (state, package_id, package_path, error_code, utc_now(), tx_id),
            )

    def apply_package(
        self,
        *,
        package_id: str,
        actor_id: str,
        first_seq: int,
        last_seq: int,
        package_hash: str,
        relative_path: str,
        operations: Sequence[Operation],
    ) -> None:
        if not operations or operations[0].actor_seq != first_seq or operations[-1].actor_seq != last_seq:
            raise ProtocolViolation("Operation package sequence range is inconsistent.")
        with self.transaction() as connection:
            existing = connection.execute(
                "SELECT sha256 FROM sw_sync_received_package WHERE package_id=?", (package_id,)
            ).fetchone()
            if existing:
                if existing[0] != package_hash:
                    raise ProtocolViolation("Received package ID was reused with different content.")
                return
            cursor = connection.execute(
                "SELECT highest_downloaded_seq FROM sw_sync_cursor WHERE source_actor_id=?",
                (actor_id,),
            ).fetchone()
            expected_seq = (int(cursor[0]) if cursor else 0) + 1
            if first_seq != expected_seq:
                raise ProtocolViolation(
                    f"Actor sequence gap for {actor_id}: expected {expected_seq}, received {first_seq}."
                )
            now = utc_now()
            connection.execute(
                """
                INSERT INTO sw_sync_received_package(
                    package_id, source_actor_id, first_seq, last_seq, sha256,
                    relative_path, state, received_at_utc
                ) VALUES (?, ?, ?, ?, ?, ?, 'received', ?)
                """,
                (package_id, actor_id, first_seq, last_seq, package_hash, relative_path, now),
            )
            affected: set[tuple[str, str]] = set()
            for operation in operations:
                duplicate = connection.execute(
                    """
                    SELECT operation_id, actor_id, actor_seq
                    FROM sw_sync_operation_log
                    WHERE operation_id=? OR (actor_id=? AND actor_seq=?)
                    """,
                    (operation.operation_id, operation.actor_id, operation.actor_seq),
                ).fetchone()
                if duplicate:
                    raise ProtocolViolation(
                        "An operation ID or actor sequence was reused with different package content."
                    )
                connection.execute(
                    """
                    INSERT INTO sw_sync_operation_log(
                        operation_id, tx_id, tx_index, tx_count, actor_id, actor_seq,
                        user_id, entity_type, entity_id, operation_type,
                        base_record_revision, output_record_revision, values_json,
                        geometry, created_at_utc
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        operation.operation_id,
                        operation.tx_id,
                        operation.tx_index,
                        operation.tx_count,
                        operation.actor_id,
                        operation.actor_seq,
                        operation.user_id,
                        operation.entity_type,
                        operation.entity_id,
                        operation.operation_type,
                        operation.base_record_revision,
                        operation.revision,
                        canonical_json(dict(operation.values)),
                        operation.geometry,
                        operation.created_at_utc,
                    ),
                )
                affected.add((operation.entity_type, operation.entity_id))
            for entity_type, entity_id in sorted(
                affected, key=lambda item: (dependency_order(item[0]), item[0], item[1])
            ):
                self._recompute_entity(connection, entity_type, entity_id)
            for operation in operations:
                result = connection.execute(
                    "SELECT terminal_result FROM sw_sync_operation_log WHERE operation_id=?",
                    (operation.operation_id,),
                ).fetchone()[0]
                connection.execute(
                    """
                    INSERT OR REPLACE INTO sw_sync_applied_operation(
                        operation_id, actor_id, actor_seq, tx_id, result, applied_at_utc
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        operation.operation_id,
                        operation.actor_id,
                        operation.actor_seq,
                        operation.tx_id,
                        result,
                        now,
                    ),
                )
            connection.execute(
                "UPDATE sw_sync_received_package SET state='terminal' WHERE package_id=?",
                (package_id,),
            )
            connection.execute(
                """
                INSERT INTO sw_sync_cursor(
                    source_actor_id, highest_downloaded_seq, highest_terminal_seq,
                    last_package_id, updated_at_utc
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(source_actor_id) DO UPDATE SET
                    highest_downloaded_seq=excluded.highest_downloaded_seq,
                    highest_terminal_seq=excluded.highest_terminal_seq,
                    last_package_id=excluded.last_package_id,
                    updated_at_utc=excluded.updated_at_utc
                """,
                (actor_id, last_seq, last_seq, package_id, now),
            )
            connection.execute(
                "UPDATE sw_sync_install_state SET last_successful_sync_at_utc=? WHERE singleton=1",
                (now,),
            )

    def _recompute_entity(
        self, connection: sqlite3.Connection, entity_type: str, entity_id: str
    ) -> None:
        self._require_registered_entity_type(entity_type)
        rows = connection.execute(
            """
            SELECT * FROM sw_sync_operation_log
            WHERE entity_type=? AND entity_id=?
            ORDER BY actor_id, actor_seq, operation_id
            """,
            (entity_type, entity_id),
        ).fetchall()
        seed = connection.execute(
            "SELECT * FROM sw_sync_entity_seed WHERE entity_type=? AND entity_id=?",
            (entity_type, entity_id),
        ).fetchone()
        body = json.loads(seed["body_json"]) if seed else {}
        geometry = seed["geometry"] if seed else None
        deleted = bool(seed["deleted"]) if seed else False
        current_revision = seed["base_record_revision"] if seed else None
        by_base: dict[str | None, list[sqlite3.Row]] = {}
        known_revisions = {row["output_record_revision"] for row in rows}
        if seed and seed["base_record_revision"]:
            known_revisions.add(seed["base_record_revision"])
        for row in rows:
            by_base.setdefault(row["base_record_revision"], []).append(row)

        selected_ids: set[str] = set()
        selected_operation_id: str | None = None
        conflict_ids: set[str] = set()
        while True:
            candidates = by_base.get(current_revision, [])
            if not candidates:
                break
            candidates = sorted(
                candidates,
                key=lambda row: (row["actor_id"], row["actor_seq"], row["operation_id"]),
            )
            selected = candidates[-1]
            selected_ids.add(selected["operation_id"])
            selected_operation_id = selected["operation_id"]
            if len(candidates) > 1:
                candidate_ids = sorted(row["operation_id"] for row in candidates)
                fingerprint = canonical_json(
                    [entity_type, entity_id, current_revision, candidate_ids]
                ).encode("utf-8")
                conflict_id = hashlib.sha256(fingerprint).hexdigest()
                conflict_ids.add(conflict_id)
                connection.execute(
                    """
                    INSERT INTO sw_sync_conflict(
                        conflict_id, entity_type, entity_id, base_record_revision,
                        candidate_operation_ids_json, selected_operation_id, state, detected_at_utc
                    ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)
                    ON CONFLICT(conflict_id) DO UPDATE SET
                        candidate_operation_ids_json=excluded.candidate_operation_ids_json,
                        selected_operation_id=excluded.selected_operation_id,
                        state='open'
                    """,
                    (
                        conflict_id,
                        entity_type,
                        entity_id,
                        current_revision,
                        canonical_json(candidate_ids),
                        selected["operation_id"],
                        utc_now(),
                    ),
                )
            operation_type = selected["operation_type"]
            values = json.loads(selected["values_json"])
            if operation_type == "insert_entity":
                body = dict(values)
                deleted = False
            elif operation_type in {"update_fields", "update_entity", "transfer_owner"}:
                body.update(values)
            elif operation_type == "update_geometry":
                pass
            elif operation_type == "delete_entity":
                deleted = True
            elif operation_type == "restore_entity":
                body.update(values)
                deleted = False
            elif operation_type == "append_event":
                if physical_spec(entity_type):
                    raise ProtocolViolation(
                        f"Typed entity {entity_type} must store events as registered event rows."
                    )
                events = list(body.get("events", []))
                events.append(values)
                body["events"] = events
            if selected["geometry"] is not None:
                geometry = selected["geometry"]
            current_revision = selected["output_record_revision"]

        if current_revision is None:
            delete_physical_entity(connection, entity_type, entity_id)
            connection.execute(
                "DELETE FROM sw_sync_entity WHERE entity_type=? AND entity_id=?",
                (entity_type, entity_id),
            )
        else:
            if physical_spec(entity_type):
                if geometry is not None:
                    raise ProtocolViolation(
                        f"Typed entity {entity_type} does not define a geometry column."
                    )
                materialize_physical_entity(
                    connection,
                    entity_type,
                    entity_id,
                    body,
                    record_revision=str(current_revision),
                    deleted=deleted,
                    conflict_state="open" if conflict_ids else "none",
                    selected_operation_id=selected_operation_id,
                )
            else:
                connection.execute(
                    """
                    INSERT INTO sw_sync_entity(
                        entity_type, entity_id, body_json, geometry, record_revision,
                        deleted, conflict_state, selected_operation_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(entity_type, entity_id) DO UPDATE SET
                        body_json=excluded.body_json, geometry=excluded.geometry,
                        record_revision=excluded.record_revision, deleted=excluded.deleted,
                        conflict_state=excluded.conflict_state,
                        selected_operation_id=excluded.selected_operation_id
                    """,
                    (
                        entity_type,
                        entity_id,
                        canonical_json(body),
                        geometry,
                        current_revision,
                        int(deleted),
                        "open" if conflict_ids else "none",
                        selected_operation_id,
                    ),
                )
        connection.execute(
            "UPDATE sw_sync_operation_log SET terminal_result='deferred' WHERE entity_type=? AND entity_id=?",
            (entity_type, entity_id),
        )
        for row in rows:
            if row["operation_id"] in selected_ids:
                result = "applied"
            elif row["base_record_revision"] in known_revisions or row["base_record_revision"] is None:
                result = "conflict"
            else:
                result = "deferred"
            connection.execute(
                "UPDATE sw_sync_operation_log SET terminal_result=? WHERE operation_id=?",
                (result, row["operation_id"]),
            )
        if conflict_ids:
            placeholders = ",".join("?" for _ in conflict_ids)
            connection.execute(
                f"""
                UPDATE sw_sync_conflict SET state='superseded'
                WHERE entity_type=? AND entity_id=? AND state='open'
                  AND conflict_id NOT IN ({placeholders})
                """,
                (entity_type, entity_id, *sorted(conflict_ids)),
            )
        else:
            connection.execute(
                """
                UPDATE sw_sync_conflict SET state='superseded'
                WHERE entity_type=? AND entity_id=? AND state='open'
                """,
                (entity_type, entity_id),
            )

    @staticmethod
    def _require_registered_entity_type(entity_type: str) -> None:
        if is_managed_entity_type(entity_type) and physical_spec(entity_type) is None:
            raise ProtocolViolation(
                f"Business entity type {entity_type} is not registered with a physical table."
            )

    def update_actor_head(self, head: ActorHead) -> None:
        with self.transaction() as connection:
            connection.execute(
                """
                UPDATE sw_sync_actor
                SET head_generation=?, head_package_id=?
                WHERE actor_id=?
                """,
                (head.generation, head.package.package_id if head.package else None, head.actor_id),
            )

    def status(self) -> dict[str, object]:
        with closing(self.connect()) as connection:
            actor = connection.execute("SELECT * FROM sw_sync_actor WHERE singleton=1").fetchone()
            install = connection.execute(
                "SELECT * FROM sw_sync_install_state WHERE singleton=1"
            ).fetchone()
            conflicts = connection.execute(
                "SELECT COUNT(*) FROM sw_sync_conflict WHERE state='open'"
            ).fetchone()[0]
            prepared = connection.execute(
                "SELECT COUNT(*) FROM sw_sync_outbox_transaction WHERE state NOT IN ('applied','voided')"
            ).fetchone()[0]
            cursors = {
                row["source_actor_id"]: row["highest_terminal_seq"]
                for row in connection.execute("SELECT * FROM sw_sync_cursor")
            }
            return {
                "database": str(self.database_path),
                "actor_id": actor["actor_id"] if actor else None,
                "next_actor_seq": actor["next_actor_seq"] if actor else None,
                "installed_snapshot_id": install["installed_snapshot_id"] if install else None,
                "last_successful_sync_at_utc": install["last_successful_sync_at_utc"] if install else None,
                "open_conflicts": conflicts,
                "prepared_transactions": prepared,
                "cursors": cursors,
            }
