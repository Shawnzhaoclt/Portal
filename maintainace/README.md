# Portal Database Maintainace Utilities

This folder contains standalone database maintainace helpers for Portal. They run without starting the backend API.

Use this folder for:

- database deployment and seeding;
- schema/resource upgrades;
- SQLite database backups;
- SQLite database restores.

The folder name is `maintainace` to match the project convention requested for this utility area.

## Commands

Run commands from the Portal project root.

### Deploy And Seed

Creates or migrates the SQLite management database, creates resource-owned tables such as `RPT5W1C0_...`, registers resource metadata, and seeds users/teams from `PTO_ORG.csv`.

```powershell
python -m maintainace.portal_maintenance init-db
```

With explicit deployment paths:

```powershell
python -m maintainace.portal_maintenance init-db `
  --db C:\PortalData\portal_management.sqlite3 `
  --org-csv C:\Deploy\PTO_ORG.csv `
  --admin-emails robert.jarzemsky@charlottenc.gov,crystal.williams@charlottenc.gov `
  --system-admin-emails shawn.zhao@charlottenc.gov
```

### Upgrade

Applies schema upgrades and refreshes resource metadata without reseeding users and teams by default.

```powershell
python -m maintainace.portal_maintenance upgrade-db --db C:\PortalData\portal_management.sqlite3
```

To also refresh teams and users from the organization CSV:

```powershell
python -m maintainace.portal_maintenance upgrade-db --seed-org --org-csv .\PTO_ORG.csv
```

### Backup

Creates a SQLite backup. If no backup path is provided, a timestamped file is written under `maintainace/backups`.

```powershell
python -m maintainace.portal_maintenance backup-db --db C:\PortalData\portal_management.sqlite3
```

With an explicit backup path:

```powershell
python -m maintainace.portal_maintenance backup-db `
  --db C:\PortalData\portal_management.sqlite3 `
  --backup C:\PortalBackups\portal_management_20260709.sqlite3
```

### Restore

Restores the management database from a backup. If the target DB already exists, `--force` is required. By default, restore creates a pre-restore safety backup of the current target DB.

```powershell
python -m maintainace.portal_maintenance restore-db `
  --db C:\PortalData\portal_management.sqlite3 `
  --backup C:\PortalBackups\portal_management_20260709.sqlite3 `
  --force
```

### Summary

Prints tracked Portal table counts and foreign-key status.

```powershell
python -m maintainace.portal_maintenance summary --db C:\PortalData\portal_management.sqlite3
```

## PowerShell Wrapper

The wrapper accepts the same actions:

```powershell
.\maintainace\manage_database.ps1 -Action init-db -DatabasePath C:\PortalData\portal_management.sqlite3 -OrgCsvPath .\PTO_ORG.csv
.\maintainace\manage_database.ps1 -Action upgrade-db -DatabasePath C:\PortalData\portal_management.sqlite3
.\maintainace\manage_database.ps1 -Action backup-db -DatabasePath C:\PortalData\portal_management.sqlite3
.\maintainace\manage_database.ps1 -Action restore-db -DatabasePath C:\PortalData\portal_management.sqlite3 -BackupPath C:\PortalBackups\portal_management_20260709.sqlite3 -Force
.\maintainace\manage_database.ps1 -Action summary -DatabasePath C:\PortalData\portal_management.sqlite3
```

Use `-Python` when the deployment machine needs a specific environment:

```powershell
.\maintainace\manage_database.ps1 -Action init-db -Python C:\Users\105692\AppData\Local\miniconda3\envs\portal\python.exe
```

## Environment Variables

The CLI sets these environment variables before importing backend modules:

- `PORTAL_MANAGEMENT_DB`: SQLite database path. Defaults to `backend/data/portal_management.sqlite3`.
- `PORTAL_PTO_ORG_CSV`: user/team seed CSV. Defaults to `PTO_ORG.csv`.
- `PORTAL_DEFAULT_ADMIN_EMAILS`: comma-separated admin users.
- `PORTAL_DEFAULT_SYSTEM_ADMIN_EMAILS`: comma-separated system admin users.

The initial password for seeded users is their employee ID. Current testing mode does not force password change on first login.

## Safety Notes

- `init-db` is idempotent and can be rerun to apply schema migrations, refresh resource metadata, and update user/team seed data.
- `upgrade-db` is intended for routine upgrades. It does not reseed users/teams unless `--seed-org` is provided.
- `backup-db` uses SQLite's backup API instead of copying a potentially live DB file.
- `restore-db` validates the backup as SQLite input and creates a pre-restore safety backup unless `--no-safety-backup` is used.
- The seed process does not delete users missing from the CSV. It updates existing users by `employee_id`, restores active status for seeded users, and preserves password changes after initial creation.
