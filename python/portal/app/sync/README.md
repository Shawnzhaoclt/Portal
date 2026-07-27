# Portal Data Coordinator

This package implements the Python-only v1 LAN synchronization protocol described in:

- `docs/LAN_OFFLINE_VECTOR_DATA_SYNC_DESIGN_EN.md`
- `docs/LAN_OFFLINE_VECTOR_DATA_SYNC_DESIGN.md`

It is an in-process module. It does not start a service and exposes no HTTP API.

## Runtime contract

- The local writable database is a complete SQLite/GeoPackage replica.
- Each formal save publishes one immutable SQLite `.opdb` package.
- Atomic replacement of the actor's `head.json` is the commit point.
- Final `.opdb` files not reachable from a valid head are ignored as orphans.
- Every save uses the current snapshot epoch's active-writer registry for a pre-lock and in-lock synchronization barrier.
- Record and unique-key mutexes use Windows SMB byte-range locks.
- Membership releases and snapshots require a compatible protocol, schema, and
  coordinator version. The recorded Python runtime version is diagnostic metadata,
  so packaged clients and the workstation coordinator do not fail solely because
  they were built with different Python patch or minor versions.
- A missing share permits application-defined degraded read-only use of the existing local replica; this module blocks sync and formal save.

## Python API

```python
from pathlib import Path
from portal.app.sync import DataCoordinator, Identity, Mutation

coordinator = DataCoordinator(
    identity=Identity("user-guid", "105692", "user@example.gov"),
    database_path=Path("data/stormwater.db"),
    network_root=Path(r"G:\Strategic Planning\Planning\stm_risk_data\portal\data"),
)
coordinator.initialize()

result = coordinator.commit([
    Mutation(
        entity_type="inspection_review",
        entity_id="review-1",
        operation_type="insert_entity",
        base_record_revision=None,
        values={"status": "pending"},
    )
])
```

Production code should normally construct the coordinator with
`DataCoordinator.from_desktop_config(identity)`, which reads `business.database` and
`businessSync.networkRoot` from the single Portal settings file.

## Maintenance bootstrap

Bootstrap is intentionally a maintenance/deployment action, not a client startup action:

```powershell
$env:PYTHONPATH = "python"
python -m portal.app.sync bootstrap `
  --network-root "G:\Strategic Planning\Planning\stm_risk_data\portal\data" `
  --member "user-guid:105692:user@example.gov"
```

Use `initialize`, `status`, `sync`, and `recover` for diagnostics. The bootstrap command
creates an empty full-replication snapshot and membership release; production snapshot
generation and retention remain maintenance-workstation responsibilities.

## Implementation boundary

The coordinator owns membership validation, snapshot installation, actor registration,
operation publication, synchronization barriers, deterministic reduction, recovery, and
local IPC commands. Domain tables can be projected from `sw_sync_entity` by resource-specific
adapters. Snapshot compaction/publication, five-snapshot retention, conflict-report exports,
and signed-device operation packages belong to the maintenance workstation module.
