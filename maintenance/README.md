# Portal Database Maintenance

Standalone utilities for SQLite deployment, schema/resource upgrades, backup, restore, and validation. They do not start the desktop application or a local service. System publications and writable business databases are maintained separately.

Run commands from the project root:

```powershell
python -m maintenance.portal_maintenance init-db --kind system
python -m maintenance.portal_maintenance init-db --kind business
python -m maintenance.portal_maintenance upgrade-db --kind business --db C:\PortalData\portal_business.sqlite3
python -m maintenance.portal_maintenance backup-db --kind business --db C:\PortalData\portal_business.sqlite3
python -m maintenance.portal_maintenance restore-db --kind business --db C:\PortalData\portal_business.sqlite3 --backup C:\PortalBackups\portal.sqlite3 --force
python -m maintenance.portal_maintenance summary --kind system --db C:\PortalData\portal_system.sqlite3
```

The PowerShell wrapper provides the same operations:

```powershell
.\maintenance\manage_database.ps1 -Action summary -DatabaseKind business -DatabasePath C:\PortalData\portal_business.sqlite3
```

Without `--db`, defaults are `python/portal/data/portal_system.sqlite3` and `python/portal/data/portal_business.sqlite3`, selected by `--kind`. A portable build publishes these source seeds as read-only `config\system.db` and writable `data\business.db`. Rust opens the system database in place and copies the business seed to `%LOCALAPPDATA%\Portal\data\business.db` for normal runtime writes.

Backups use SQLite's backup API. Restore validates SQLite input and creates a safety backup unless `--no-safety-backup` is supplied.

## Publish Read-Only Reference Data

DuckDB, PMTiles, MapLibre styles/sprites, and map configuration are deliberately
excluded from the portable app. Publish an approved map build to the configured shared
data root with:

```powershell
.\maintenance\publish_reference_data.ps1
```

The source and destination roots come from
`dist\Portal-Desktop\config\portal.settings.json`. Both roots can still be supplied as
explicit parameters for a one-off publication. The command validates the AM Team
DuckDB and required published map files after copying; it does not modify the source
build.
