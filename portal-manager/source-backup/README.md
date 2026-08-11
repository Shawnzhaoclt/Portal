# Portal Manager source backup

This directory is the maintained source for the workstation SQL Server mirror and
source-data archive workflow. Portal Manager and Windows Task Scheduler both call
`coordinator/source_backup_runner.py`; the batch file is retained as a compatible
manual entry point.

The workflow performs a clean rebuild of the configured DuckDB mirrors every day.
On the configured weekly backup day, it first archives the standard DuckDB files and
the configured deliverables, QA/QC, and lookup directories, then separately rebuilds
the Spatial Data Warehouse mirror `virt_sdw_01_sdw_spatial_warehouse.duckdb` from
`virt-sdw-01/SDW`. That dedicated 68-layer mirror is intentionally excluded from
the archive. FileGDB generation is disabled; the workflow now maintains DuckDB
mirrors only. Notifications and the machine-online heartbeat use Outlook automation.
Each spatial layer in that dedicated mirror is physically written in `ST_Hilbert`
order and receives a DuckDB R-Tree index on its geometry column.

Configuration is held in the two JSON files beside the scripts. SQL passwords must
not be stored in source control. `clone_sqlserver_to_duckdb.json` references the
current Windows user's `PORTAL_ITPIPES_SQL_PASSWORD` environment setting for the
ITPipes SQL login.

Ordinary operation, schedule registration, status review, and logs are available on
Portal Manager's **Source Backup** page.

Portal Manager retains only the 10 most recent source-backup run records. When an
older run is removed from the history, its Portal-generated log file is removed from
the managed log directory as well; source databases and retained archives are not
affected.

The **Refresh mirrors** action rebuilds both the standard SQL Server mirrors and
the separate Spatial Data Warehouse mirror immediately, without creating an archive.

The Manager owns two Windows scheduled tasks for this workflow:

- `StormWater Portal Source Backup Workflow`
- `StormWater Portal Machine Heartbeat`
