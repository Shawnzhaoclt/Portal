# Portal data publication

`publish_data_versions.py` is the single manifest publisher used by Portal Manager,
Portal Source Data, and STM Risk. It validates configured producer outputs, writes the
producer-owned fragment, and merges all Desktop-enabled sources into
`databases_local/portal-data.current.json` under a short atomic lock.

Example:

```powershell
python publish_data_versions.py --config publication.settings.json --producer manager-daily-mirrors
```

To publish the authoritative Manager catalog into the shared read-only location:

```powershell
python publish_data_versions.py --config publication.settings.json --producer system-catalog `
  --stage-source system.catalog=C:\path\to\config\system.db
```

Producer source paths are maintained only in `publication.settings.json`; scripts do
not embed shared-drive paths.
