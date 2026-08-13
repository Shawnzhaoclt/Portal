# Portal Desktop Local Data Versioning and Cache Design

**Status:** Approved design

**Date:** August 12, 2026

**Applies to:** Portal Desktop, Portal Manager, and the scheduled Python data-publication workflows

## 1. Purpose

Portal Desktop currently reads several large read-only data files from the shared
`G:` drive. This design adds a managed local cache so resources normally read from a
fast, verified local copy while the existing Python-maintained source files remain at
their current shared locations.

The design must:

- keep the existing Python-owned DuckDB, PMTiles, SQLite, and terrain files in place;
- check every registered data source once whenever Portal Desktop starts;
- download missing or excessively stale data before opening the application;
- download newer, noncritical versions in the background when a usable local version
  is still within the allowed grace period;
- ensure every resource resolves the newest active local version through one central
  data-source resolver;
- validate files before activation and never expose partial downloads;
- retain only the newest active local version after it is safe to remove older files;
- support the different publication cycles of terrain, weekly spatial data, daily
  source data, and event-driven `system.db` releases.

This design does not move, rename, or take ownership of the existing Python-maintained
shared data files.

## 2. Design Principles

1. **The G-drive publication remains authoritative.** The local cache is a disposable,
   verified runtime copy.
2. **Versioning is metadata-driven.** Existing source filenames may remain fixed; the
   publication manifest supplies their version identities.
3. **Resources never select physical files themselves.** They request a logical data
   source from a central resolver.
4. **Activation is atomic.** A file is downloaded, validated, and then made active in
   one metadata switch.
5. **Publication groups are consistent.** Files that must work together are activated
   as one release.
6. **Startup remains deterministic.** Remote state is checked once per application
   startup. Portal Desktop does not poll every four hours or switch to newly published
   remote data later in the same session.
7. **Usable local data wins over network failure.** If the shared drive is unavailable,
   a verified local copy remains available in offline mode.
8. **Writable business data remains separate.** The local `stormwater.db` is not part
   of the read-only source-data cache.
9. **No direct shared-drive fallback.** After migration, resources do not silently
   bypass the cache and read a configured G-drive source directly.

## 3. Scope

### 3.1 Included data

The cache supports the following registered formats:

- DuckDB databases, including files whose extension is `.db`;
- SQLite publications, including the Portal serving database and Desktop `system.db`;
- PMTiles vector archives;
- PMTiles terrain archives;
- GeoTIFF/Cloud Optimized GeoTIFF terrain data;
- small manifest sidecars required to validate or interpret those files.

Only data sources explicitly registered in the central publication manifest are
managed. The application must not discover and download every database found in a
folder.

### 3.2 Excluded data

The following are outside this cache:

- `%LOCALAPPDATA%\StormWaterPortal\data\stormwater.db`;
- business synchronization `.opdb` files;
- recovery databases and temporary database copies;
- CCTV videos, snapshots, and other media on their existing media shares;
- generated Excel files, reports, logs, and temporary files;
- application code, styles, sprites, icons, and other packaged resources;
- unregistered databases that happen to exist below `databases_local` or
  `intermediate`.

## 4. Authoritative Source Groups and Update Cycles

The publication manifest is an explicit allowlist. It assigns each source to an update
class, producer, and, when required, an atomic activation group. Directory membership
does not establish ownership: different workflows publish data below
`databases_local`, so each producer must register only the outputs declared in its own
configuration.

### 4.1 Terrain group

These files are updated together approximately every three to four years:

- `mecklenburg_dem.tif`
- `mecklenburg_terrain.pmtiles`

They form the `terrain` activation group. A new COG and terrain archive must be
published and activated together when they represent the same elevation release.

### 4.2 Weekly Saturday spatial group

Portal Manager currently registers one Windows task,
`StormWater Portal Source Backup Workflow`, which runs the source workflow daily. Its
Saturday branch additionally publishes:

- `virt_sdw_01_sdw_spatial_warehouse.duckdb`
- `portal_core_storm.pmtiles`
- `portal_property_surfaces.pmtiles`
- `portal_planning_projects.pmtiles`
- `portal_transport_reference.pmtiles`
- the four corresponding `.pmtiles.manifest.json` sidecars.

These files form the `weekly-sdw-map` activation group. Portal Desktop must never
activate a new archive set with an older spatial warehouse database, or activate the
new database with only part of the new archive set. The group version is registered by
the Portal Manager coordinator only after the SDW spatial clone, all four PMTiles
builds, all four sidecars, and cross-file validation succeed.

### 4.3 Daily Portal Manager mirror group

Every run of the same Portal Manager task rebuilds the configured ordinary SQL Server
DuckDB mirrors under:

```text
G:\Strategic Planning\Planning\stm_risk_data\databases_local
```

The current producer configuration owns:

- `virt_sde_01_stm.duckdb`
- `virt_sdw_01_stm.duckdb`
- `itpipes_stormwater_prod.duckdb`
- `myrs_cwdbprd_1_swpt_cityworks_db.duckdb`
- `myrs_cwdbprd_1_stw_cityworks_sd.duckdb`
- `virt_sdw_01_sdw.duckdb`
- `virt_sdw_01_sdw_tableau.duckdb`

These outputs form the `manager-daily-mirrors` producer release. The producer fragment
may inventory all successfully generated outputs, but only explicitly registered
Portal sources with `desktopEnabled: true` are merged into the Desktop manifest and
downloaded by Portal Desktop. Files created by the Portal serving-data, terrain, or
other workflows remain owned by those workflows even when they are stored below the
same `databases_local` directory.

### 4.4 Daily STM Risk intermediate group

The STM Risk Python workflow updates the registered DuckDB files under:

```text
G:\Strategic Planning\Planning\stm_risk_data\intermediate
```

Current registered sources include:

- `amteam\amteam.duckdb`
- `citypipes\citypipes.db`
- `cityworks\cityworks.db`
- `hydraulics\hydraulics.db`
- `inventory\inventory.db`
- `itpipes\itpipes.db`
- `planning\planning.db`
- `proactive\proactive.duckdb`
- `prioritypipes\prioritypipes.db`
- `riskranking\riskranking.db`

The `.db` files in this group are DuckDB databases, not SQLite databases.

These files form the `stm-risk-intermediate` release group. The existing
`001_MAIN.bat` launcher invokes `main.py`; the numbered workflow stages are implemented
inside that Python pipeline. Step 1000 is the final QA/QC log-cleaning operation. A new
**Step 1100 - Publish Portal intermediate-data versions** must run in `main.py`
immediately after Step 1000 succeeds and before the pipeline returns success. It must
not be implemented as an unguarded command appended to the batch file.

### 4.5 Portal serving SQLite publication

The existing serving publication uses:

```text
databases_local\portal\portal_sources.current.json
databases_local\portal\versions\portal_sources_<version>.sqlite3
```

The central manifest registers the currently published immutable SQLite version as a
logical source. This source is the one direct-network exception to the Desktop cache:

- the published database remains below 100 MB and is rebuilt approximately every five
  minutes;
- Desktop reads `portal_sources.current.json` directly from the shared drive and opens
  the referenced immutable SQLite version read-only;
- every database operation resolves the pointer manifest again, so a running Desktop
  session can use a newly published snapshot without restarting;
- an already-open request may finish against its original immutable snapshot, while
  the next request uses the newly active version;
- if the shared drive is unavailable, resources backed by `portal.serving` report that
  their live serving data is unavailable. They do not use a stale cached copy.

The Manager must publish a new version completely and atomically replace the pointer
manifest only after validation. It retains enough previous immutable versions for
requests that started immediately before a five-minute publication switch.

### 4.6 `system.db`

`system.db` is event-driven rather than daily or weekly:

- Portal Manager owns the authoritative writable database.
- A System Admin publishes it from **Portal Administration > System Catalog**.
- Publication requires no software version or manually entered data version.
- Manager publishes a verified read-only Desktop copy through the same central data
  publication manifest used by DuckDB and PMTiles sources.
- The data publisher generates the immutable content version from publication time and
  checksum; unchanged content retains the existing version.
- The data manifest carries its content version, checksum, schema fingerprint, and
  compatibility information.
- Desktop must activate a required `system.db` update before user authentication.
- Desktop must not replace `system.db` silently after authentication in the same
  session.
- A packaged, compatible copy remains available for installation and recovery in
  the single software release manifest.
- Portal software releases remain separate: executable and full-package releases use
  semantic software versions, while `system.db` publication does not update the
  software release manifest.

### 4.6 Unified software release manifest

Portal software has one semantic version sourced from the built package `VERSION`
file. Portal Manager does not maintain separate package, current-release, and
bootstrap version numbers. It publishes one atomic `portal-release.json` containing:

- `version`: the single software version;
- `updateMode`: `portal-exe` or `full`, indicating what an existing installation
  replaces;
- `payload`: the verified update artifact used by existing installations;
- `installationPayload`: a verified complete ZIP used for installation, repair, and
  recovery;
- `preservePaths: ["data"]`: a declarative record of the protected data-sync folder.

The complete installation ZIP is produced for every release. The publisher excludes
the top-level `data` directory, and the updater independently refuses any target under
`%LOCALAPPDATA%\StormWaterPortal\data`. A full update may replace
`%LOCALAPPDATA%\StormWaterPortal\app` and managed configuration, but it must never
delete, overwrite, roll back, or package data-sync content. The manifest is committed
only after both referenced artifacts and their SHA-256 values have been generated.

## 5. Central Configuration

### 5.1 Desktop configuration

`portal.settings.json` contains only the cache service entry and the stable remote
manifest location. Individual runtime resources reference logical data-source IDs,
not physical G-drive paths.

```json
{
  "dataCache": {
    "enabled": true,
    "remoteManifest": "${PORTAL_SHARED_DATA_ROOT}/databases_local/portal-data.current.json",
    "localRoot": "${PORTAL_DATA_ROOT}/data/source-cache",
    "checkPolicy": "startup-only",
    "directNetworkSourceIds": ["portal.serving"],
    "gracePeriodDays": 7,
    "maximumConcurrentDownloads": 1,
    "retainActiveVersions": 1,
    "resumePartialDownloads": true,
    "minimumStartupFreeBytes": 16106127360,
    "diskSafetyReserveBytes": 1073741824,
    "stagingRecoveryHours": 72
  }
}
```

`${PORTAL_SHARED_DATA_ROOT}` is defined once by the application configuration. Source
scripts and resources must not embed the full G-drive path in code.

Cache-backed Desktop settings declare a logical source ID for every DuckDB,
`system.db`, PMTiles, COG, and terrain source. Their optional physical fallback values
are confined to `${PORTAL_DATA_ROOT}/data/source-cache`; they must never point to
`${PORTAL_SHARED_DATA_ROOT}`. The shared root remains valid for the central publication
manifest, explicitly network-owned coordination data, and the single
`portal.serving` direct-network exception. The portable build validates this rule,
rejects any other direct-network source, and fails if a cache-backed database or
PMTiles setting reintroduces a shared-drive fallback.

`dataSources.portalSources` retains logical ID `portal.serving`, declares
`accessMode: direct-network`, and points to:

```text
${PORTAL_SHARED_DATA_ROOT}/databases_local/portal/portal_sources.current.json
```

The same ID appears in `dataCache.directNetworkSourceIds`, which prevents the generic
cache manager from downloading or reporting this source as a locally active version.

Before reading the remote manifest or starting authentication, Portal checks the drive
containing `${PORTAL_DATA_ROOT}`. Startup is blocked when less than 15 GB is free, and
the splash screen tells the user to free disk space before retrying. Per-download disk
checks continue to reserve the configured safety margin in addition to this startup
minimum.

`Download-Portal.bat` is an explicit bootstrap refresh. If the local installation
already exists, every corresponding packaged application and configuration file is
overwritten from the verified full bundle. User-owned files below
`%LOCALAPPDATA%\StormWaterPortal\data`, including `stormwater.db` and cached source
versions, are outside the package and remain intact.

### 5.2 Remote publication manifest

The authoritative central manifest is:

```text
G:\Strategic Planning\Planning\stm_risk_data\databases_local\portal-data.current.json
```

Paths in this manifest are relative to the configured shared-data root. A representative
entry is:

```json
{
  "manifestSchemaVersion": 1,
  "publicationId": "20260812T153000Z-4d8a31c2",
  "publishedAtUtc": "2026-08-12T15:30:00Z",
  "sources": [
    {
      "id": "map.core-storm",
      "producer": "portal-manager-source-workflow",
      "producerReleaseId": "manager-weekly-sdw-map-20260812T152700Z",
      "displayName": "Core storm map archive",
      "source": "databases_local/tiles/portal_core_storm.pmtiles",
      "format": "pmtiles-vector",
      "version": "20260812T152700Z-bca25e81",
      "publishedAtUtc": "2026-08-12T15:27:00Z",
      "sizeBytes": 135266304,
      "sha256": "<sha256>",
      "schemaFingerprint": "<source-layer fingerprint>",
      "updateClass": "weekly-saturday",
      "activationGroup": "weekly-sdw-map",
      "desktopEnabled": true,
      "requiredAtStartup": false,
      "priority": 40,
      "readOnly": true
    }
  ]
}
```

Each source record contains at least:

| Field | Purpose |
|---|---|
| `id` | Stable logical source ID used by resources |
| `producer` | Workflow that exclusively owns this source record |
| `producerReleaseId` | Successful producer-run identity containing this version |
| `displayName` | User-facing progress and diagnostics name |
| `source` | Relative authoritative source path |
| `format` | Validation and opening strategy |
| `version` | Immutable content version identity |
| `publishedAtUtc` | Beginning of the local grace-period calculation |
| `sizeBytes` | Progress and disk-space calculation |
| `sha256` | End-to-end content validation |
| `schemaFingerprint` | Expected tables, layers, or schema identity |
| `updateClass` | Terrain, weekly, daily, or event-driven |
| `activationGroup` | Atomic multi-file release boundary |
| `desktopEnabled` | Whether this source is included in the Desktop cache allowlist |
| `requiredAtStartup` | Whether the application may open without this source |
| `priority` | Sequential download order |
| `readOnly` | Required local file permission and connection mode |

Optional format-specific metadata includes required tables and columns, PMTiles source
layers, CRS, geographic bounds, tile zoom range, terrain encoding, application-version
compatibility, and sidecar relationships.

### 5.3 Producer manifest fragments

Each workflow owns a separate manifest fragment under:

```text
G:\Strategic Planning\Planning\stm_risk_data\databases_local\publications
```

The initial fragments are:

```text
manager-daily-mirrors.current.json
manager-weekly-sdw-map.current.json
stm-risk-intermediate.current.json
portal-serving-data.current.json
system-catalog.current.json
terrain.current.json
```

A producer may update only its own fragment and logical source IDs. The shared
publication utility validates that ownership rule, acquires the central manifest lock,
and merges the new fragment into `portal-data.current.json` while preserving entries
owned by every other producer. This prevents concurrent Portal Manager and STM Risk
runs from replacing or deleting each other's registrations.

Producer fragments may include all outputs maintained by that producer for operational
inventory. The central Desktop manifest includes only records marked
`desktopEnabled: true`. Consequently, Portal Desktop never downloads an unused file
merely because it exists under `databases_local` or `intermediate`.

### 5.4 Version identity

Version identities are generated and maintained by the publication process. Users do
not enter them manually.

The standard form is:

```text
<UTC publication timestamp>-<first 8 characters of SHA-256>
```

Example:

```text
20260812T152700Z-bca25e81
```

An unchanged authoritative file remains the current version regardless of its age.
Staleness is measured only when the remote manifest publishes a different version.

## 6. Authoritative Publication Workflow

Existing Python jobs continue building files at their established locations. They add
a common publication step after a successful build. All producers call the same
Portal-owned publication utility; they do not implement independent manifest formats
or central-manifest rewrite logic.

### 6.1 Producer integration points

The publication calls occur at these exact workflow boundaries:

| Producer | Publication point | Fragment or group |
|---|---|---|
| Portal Manager daily source workflow | After `clone_sqlserver_to_duckdb.py` completes and all configured outputs validate | `manager-daily-mirrors` |
| Portal Manager Saturday branch | After backup, SDW spatial clone, four PMTiles builds, sidecars, and cross-file validation complete | `manager-weekly-sdw-map` |
| STM Risk `main.py` | Step 1100, immediately after Step 1000 QA/QC log cleaning succeeds | `stm-risk-intermediate` |
| Portal Source Data | After the immutable serving SQLite version and pointer validate | `portal-serving-data` |
| Portal Manager catalog publisher | After the Desktop read-only `system.db` copy validates | `system-catalog` |
| Terrain publisher | After both the DEM COG and terrain PMTiles validate | `terrain` |

The daily Manager release may be published independently before the Saturday-only
group. Therefore, a later PMTiles failure does not conceal a valid daily mirror
release. The overall Saturday task still reports failure for the failed weekly group.

### 6.2 Single-file publication

1. Build the candidate as a sibling temporary file such as `<name>.next`.
2. Close all writer connections and flush the file.
3. Perform format-specific validation.
4. Calculate file size, SHA-256, schema fingerprint, and version identity.
5. Write the prepared transaction journal and producer-fragment candidate.
6. Acquire the publication lock.
7. Atomically replace the fixed authoritative filename.
8. Atomically replace the producer fragment.
9. Merge the producer fragment into a candidate central manifest and atomically
   replace `portal-data.current.json`.
10. Mark the journal committed and release the publication lock.
11. Record publication status and diagnostics.

The central manifest is updated last. A failed build or validation never advertises a
new version.

### 6.3 Activation-group publication

For terrain and weekly SDW/map files:

1. Build every candidate outside the live names.
2. Validate every candidate and all cross-file relationships.
3. Calculate all checksums and fingerprints.
4. Prepare one producer-fragment candidate and transaction journal for the group.
5. Acquire one group publication lock.
6. Commit all fixed authoritative filenames.
7. Atomically publish the producer fragment.
8. Merge and atomically publish one central manifest that references the complete new
   group.
9. Mark the journal committed and release the lock.

The group publication is considered successful only after the central manifest switch.
Desktop ignores an in-progress candidate and continues using its verified local release.

### 6.4 Publication lock

The publisher creates a small lock/status file beside the central manifest while the
final commit is in progress. Desktop must not read a partially committed manifest. If
the lock exists at startup, Desktop briefly retries the manifest read. If the lock does
not clear within the configured short timeout, Desktop uses the current verified local
cache and reports that remote publication is in progress or unavailable.

Hashing, schema inspection, and other potentially long validations occur before the
central lock is acquired. The lock covers only the short fixed-file commit,
producer-fragment switch, and central-manifest merge. The merge uses a read-modify-write
transaction and verifies producer ownership so two independent workflows cannot lose
each other's updates.

### 6.5 Transaction journal and recovery

Because existing producer files keep their fixed G-drive names, the publisher writes a
small prepared transaction journal before replacing a live file. The journal contains
the producer ID, release ID, expected outputs, hashes, fragment candidate, and commit
state.

If the process stops after replacing data but before switching the central manifest,
the next registration run or Portal Manager configuration check must:

1. detect the prepared journal;
2. compare the fixed files with the prepared hashes;
3. finalize the producer fragment and central manifest when they match; or
4. report a recoverable publication error without advertising an unverified version.

Desktop treats a persistent publication lock or incomplete journal as an unavailable
remote publication and continues with its validated local cache. A client with no
required local copy remains on the startup screen until publication is repaired.

## 7. Local Cache Layout

The cache lives in the user-writable Portal data root:

```text
%LOCALAPPDATA%\StormWaterPortal\data\source-cache\
  current.json
  versions\
    <logical-source-id>\
      <version-id>\
        <published-file>
  staging\
    <logical-source-id>\
      <version-id>\
        <published-file>.part
  state\
    downloads.json
    verification.json
    cleanup.json
```

`current.json` is the only local activation pointer. Resources never scan version
folders and never choose a file by modification time.

### 7.1 Local activation metadata

For each source, `current.json` records:

- logical source ID;
- active version;
- validated local path;
- source publication time;
- local activation time;
- size and checksum;
- schema fingerprint;
- activation group;
- last successful startup check;
- validation state;
- read-only state.

The file is replaced atomically after all new files in an activation group have passed
validation.

## 8. Startup Decision Model

Portal Desktop checks all registered data sources once on every startup. It performs no
scheduled remote checks later in that application session.

### 8.1 Startup order

1. Enforce the single-instance rule.
2. Evaluate the maintenance window.
3. If maintenance is active, show the maintenance splash and countdown, then exit;
   do not begin a data download.
4. Load application settings and the local cache manifest.
5. Read and validate the remote central manifest.
6. Compare every registered remote version with its local active version.
7. Build the blocking and background download queues by activation group.
8. Complete all blocking downloads on the startup splash.
9. Activate and open the current verified `system.db`.
10. Match and authorize the Windows user.
11. Start the Python worker and open the Portal workspace.
12. Process the background queue sequentially.

### 8.2 Version states

Each source or activation group has one of these startup states:

| State | Meaning | Action |
|---|---|---|
| `current` | Local and remote versions match | Open local version |
| `missing` | No validated local version exists | Blocking download |
| `invalid` | Local file or metadata failed validation | Blocking replacement |
| `behind-within-grace` | New remote version is no more than seven days old | Open application and queue background download |
| `behind-beyond-grace` | New remote version has been published for more than seven days | Blocking download |
| `remote-unavailable-local-valid` | Remote cannot be checked; local copy is valid | Open in offline mode |
| `remote-unavailable-local-missing` | Remote cannot be checked; required local copy is absent | Keep splash open; offer Retry and Exit |
| `incompatible` | Remote version is not compatible with this application | Keep compatible local version and report update requirement |

### 8.3 Seven-day grace rule

The grace period begins at the new version's `publishedAtUtc`, not at the local file's
creation date and not at the normal update cycle.

Example:

- a DEM last changed three years ago is still current when its version matches the
  remote manifest;
- a daily DuckDB is still current if the producer did not publish a new version;
- if a new DuckDB was published five days ago, Desktop may open its verified older
  local copy and download the new copy in the background;
- if the new DuckDB was published eight days ago, Desktop must update it on the splash
  before opening resources.

For an activation group, the group uses the strictest member state. If any required
member is missing, invalid, incompatible, or beyond grace, the complete group is
handled as blocking.

### 8.4 Remote failure behavior

If the G drive or manifest is unavailable:

- a verified local version permits Portal to open in offline-data mode;
- the UI shows that freshness could not be checked at startup;
- no background retry loop runs during that session;
- a missing required source keeps the startup splash open with Retry and Exit;
- resources whose optional local source is missing show a clear source-unavailable
  state instead of reading from the G drive.

## 9. Download, Resume, and Validation

### 9.1 Download rules

- Download one file at a time to avoid saturating the shared drive.
- Use `<filename>.part` in the staging directory.
- Persist transferred byte counts so an interrupted copy can resume when safe.
- Preflight required free space before starting a file or activation group.
- Copy manifests and small required metadata before large payloads when that helps
  validation, but activate them only with their parent source.
- Never serve a staging file to a resource.

### 9.2 Generic validation

All files must pass:

- expected logical source and filename checks;
- expected byte size;
- SHA-256 verification;
- compatible manifest schema version;
- local path containment validation;
- read-only permission assignment where required.

After a source has been fully verified, Desktop records its size, checksum, timestamp,
and file identity. At later startups it may use this verification record when the local
file metadata is unchanged instead of hashing multi-gigabyte files every time. Any
unexpected metadata change requires a full checksum.

### 9.3 DuckDB validation

- Open with `read_only = true`.
- Confirm the DuckDB header and successful connection.
- Validate required schemas, tables, fields, geometry metadata, CRS, spatial extension
  requirements, indexes, and schema fingerprint.
- Run only bounded structural checks at startup; expensive data-quality checks remain
  part of publication.

### 9.4 SQLite validation

- Confirm the SQLite header.
- Open read-only.
- Run `PRAGMA quick_check`.
- Validate required catalog tables and schema fingerprint.
- Check application and database compatibility metadata.

### 9.5 PMTiles validation

- Validate the PMTiles header and metadata.
- Confirm expected source layers, geographic bounds, and zoom range.
- Confirm the archive manifest or sidecar checksum.
- Confirm required internal feature-ID metadata used to resolve selected tile features
  back to DuckDB rows.

### 9.6 COG validation

- Confirm the raster can be opened.
- Validate CRS, dimensions, bands, data type, nodata, tiling, and overviews.
- Confirm COG layout and the expected terrain release fingerprint.

## 10. Atomic Activation and Resource Consistency

### 10.1 Activation

After successful validation:

1. Move the staged file into its immutable version directory.
2. Apply read-only attributes.
3. Prepare the new local `current.json` entries.
4. Atomically replace `current.json` once all files in the activation group are ready.
5. Notify the resolver that a newer active version is available.

No resource can observe a half-activated group.

### 10.2 Session pinning

When a resource opens, it obtains a source snapshot token containing the logical source
IDs and active versions it will use. That resource remains pinned to those versions
until it closes or explicitly refreshes.

Consequences:

- a background activation does not replace a file underneath an open DuckDB
  connection;
- a map already displaying PMTiles does not mix old and new archives;
- newly opened or explicitly refreshed resources use the new active versions;
- authentication continues using the `system.db` selected during startup.

### 10.3 PMTiles cache identity

The custom protocol URL includes the logical source version, for example:

```text
portal-data://map.core-storm/20260812T152700Z-bca25e81/archive.pmtiles
```

This prevents WebView and MapLibre caches from returning ranges from an older archive
after local activation.

## 11. Central Data-Source Resolver

All Rust, Python, React, and resource code uses logical data-source IDs.

Conceptual resolver contract:

```text
resolve(source_id) -> {
  local_path,
  format,
  active_version,
  snapshot_token,
  read_only,
  metadata
}
```

For cache-backed sources, the resolver:

- reads only the active local cache manifest;
- validates that the path remains inside the managed cache;
- issues and tracks resource leases;
- provides version-aware URLs for PMTiles and terrain;
- supplies local DuckDB/SQLite paths to Rust and Python;
- never returns the remote G-drive path as a runtime fallback;
- exposes source status for diagnostics and the UI.

`portal.serving` does not use this local resolver. The authoritative Desktop
configuration sets `PORTAL_SOURCES_MANIFEST` to the shared-drive pointer manifest.
The SQLite snapshot helper reads that manifest for each operation and opens its current
immutable database with `mode=ro` and `immutable=1`.

In Desktop mode, resolved cache paths overwrite inherited process or machine
environment variables for cache-backed sources. This prevents an obsolete environment
variable from redirecting a resource to a former G-drive database. PMTiles and terrain
requests resolve the active local manifest by logical source/file identity and return a
source-unavailable response if no verified local version exists; they do not open the
configured remote publication file directly.

Existing resource settings keep logical table and layer mappings, but physical database
and archive paths move to the central source registry.

## 12. Cleanup and Retention

The desired steady state is one validated active local version per logical source.

Cleanup runs after successful activation and at startup:

1. Keep the active version.
2. Keep a superseded version temporarily while an open resource lease still references
   it.
3. Delete superseded versions when their lease count reaches zero.
4. Delete abandoned staging files after the configured recovery period.
5. If Windows has a file locked, record deferred cleanup and retry at the next startup.
6. Never delete the only validated local version before its replacement is active.

Thus, normal steady-state storage contains one version. Two versions may exist briefly
during download, activation, or use by an already open resource.

## 13. User Experience

### 13.1 Blocking startup download

The splash screen shows:

- `Updating Portal data`;
- current dataset display name;
- current file and total file count;
- current file bytes and percentage;
- overall bytes and percentage;
- transfer speed and estimated time remaining;
- current state: `Downloading`, `Verifying`, or `Activating`;
- Retry and Exit actions after a recoverable failure.

The application does not show raw hashes, physical cache folders, or implementation
details in the normal splash view.

### 13.2 Background update

Background downloads are sequential and low priority. A compact status indicator shows:

- `Data is current`;
- `Updating data in background`;
- `Data freshness not checked - offline`;
- `Data update needs attention`.

Closing Portal stops the active copy cleanly and preserves the `.part` file for a later
resume. The background process is not detached from the application.

### 13.3 Data Sources status page

An About or Data Sources page shows, for each logical source:

- display name;
- active local version;
- remote version observed at startup;
- last publication time;
- last successful validation time;
- update class;
- current/background/offline/error status;
- total local cache size.

System administrators may access detailed diagnostics, but end users do not manage
physical paths or versions.

## 14. Maintenance-Window Interaction

- If Portal starts during the maintenance window, it shows the maintenance countdown
  and exits without copying data.
- If the maintenance window begins while Portal is open, the existing 15-second
  shutdown warning remains authoritative.
- An in-progress background download is stopped safely and remains resumable.
- Blocking startup updates are not begun when the application already knows it must
  exit for maintenance.
- Scheduled Python publishers may continue operating independently of Desktop.

## 15. Security and Integrity

- Local source files are read-only for the Desktop runtime.
- `system.db` is distributed read-only and opened read-only.
- `stormwater.db` remains writable and is never substituted for or by `system.db`.
- Relative manifest paths are normalized and must remain inside the configured shared
  root.
- Local resolved paths must remain inside the managed cache root.
- Checksums and schema fingerprints prevent partial, stale, or substituted files from
  activating.
- Published manifests include application compatibility ranges.
- Publication and activation events are logged without exposing credentials.

## 16. Disk-Space Policy

Before a download starts, Desktop calculates:

```text
required free space = remaining staged bytes
                    + activation overhead
                    + configured safety reserve
```

The current data inventory is several gigabytes, and a large terrain or grouped update
can temporarily require nearly the size of both the old and new releases. If space is
insufficient, the splash names the required and available space and does not delete the
only working local release.

## 17. Failure and Recovery Matrix

| Failure | Required behavior |
|---|---|
| Remote manifest unavailable; local data valid | Open in offline-data mode |
| Remote manifest unavailable; required local data missing | Retry or Exit on splash |
| Publication lock remains active | Use valid local data; report remote publication unavailable |
| Copy interrupted | Preserve `.part`; resume at next startup |
| Size or checksum mismatch | Reject staging file; retry clean copy |
| Schema or source-layer validation fails | Reject new version; retain old active version |
| One member of a group fails | Activate none of the group |
| New source incompatible with current app | Retain compatible local version; request app update |
| Disk space insufficient | Retain active data; show required space and stop update |
| Old version locked by open resource | Defer deletion until lease release or next startup |
| Local active file modified unexpectedly | Mark invalid and perform blocking replacement |
| Application closes during background copy | Stop safely and preserve resumable staging state |

## 18. Logging and Diagnostics

Each startup records:

- local and remote manifest versions;
- whether the remote check succeeded;
- comparison result for every logical source;
- blocking and background queue decisions;
- copied bytes, duration, speed, and resume status;
- checksum and format-validation results;
- activation-group commit results;
- cleanup and deferred-deletion results;
- offline mode and incompatibility decisions.

Logs use logical source IDs. Normal logs avoid full user paths unless diagnostic detail
is explicitly requested.

## 19. Component Responsibilities

### 19.1 Shared Python publication library

A shared module used by the existing scheduled scripts must provide:

- producer configuration and logical-source ownership validation;
- producer-fragment creation and atomic replacement;
- central read-modify-write manifest merging that preserves unrelated producers;
- manifest entry generation;
- SHA-256 and schema fingerprint calculation;
- format-specific publication validation;
- version-ID generation;
- publication locking;
- prepared transaction journals and interrupted-commit recovery;
- atomic single-file and activation-group commit;
- central manifest update;
- structured publication logs.

The module and command-line entry point are maintained in the Portal project. External
producers such as STM Risk locate the command through configuration or an environment
variable; they must not hardcode a user-specific Portal source path. The command
accepts a producer ID, release group, and producer-owned output definition.

### 19.2 Portal Manager

Portal Manager provides administrative visibility and publication controls:

- show source groups, versions, last publication, validation, and failures;
- provide a System Admin-only **System Catalog** page that publishes the authoritative
  `system.db` as the logical `system.catalog` data source;
- generate the catalog data version automatically and never request a software or
  manually authored version number;
- copy and verify the read-only Desktop bootstrap catalog independently of the
  software release workflow;
- validate central manifest and source availability;
- expose scheduled workflow results;
- never manually edit generated version IDs.

Portal Manager does not replace the established Python ownership of the DuckDB source
builds.

The source-backup coordinator invokes publication twice on Saturday when both releases
succeed: once for the independent daily mirror release and once after the complete SDW
spatial/PMTiles group. On other days it publishes only the daily mirror release.

### 19.3 STM Risk workflow

The STM Risk main pipeline:

- continues to be launched by `001_MAIN.bat` through `main.py`;
- adds Step 1100 after the successful Step 1000 QA/QC operation;
- validates the configured intermediate DuckDB allowlist;
- publishes the `stm-risk-intermediate` producer fragment through the Portal-owned
  publication command;
- returns a nonzero result if registration fails, leaving the previous published
  release active;
- does not scan the intermediate directory or register unrelated files.

### 19.4 Tauri Desktop host

The Rust host owns `DataCacheManager`:

- startup manifest comparison;
- disk-space checks;
- resumable file copying;
- progress events for the splash;
- checksum and basic format validation;
- atomic local activation;
- file read-only attributes;
- source leases and cleanup;
- version-aware PMTiles and terrain protocols;
- offline state and diagnostics.

### 19.5 Python Desktop worker

Python:

- receives resolved active local paths from the host or shared resolver state;
- opens DuckDB and SQLite sources read-only;
- does not resolve G-drive source paths independently;
- includes the source version in query/cache identities;
- releases leases when resource work is complete.

### 19.6 React Desktop UI

React:

- renders blocking startup progress;
- shows background/offline/update status;
- presents the Data Sources diagnostic view;
- refreshes resource source tokens only when opening or explicitly refreshing a
  resource;
- does not manipulate physical files.

## 20. Implementation Sequence

1. Define the central and producer-fragment JSON schemas, logical source registry,
   producer ownership rules, and compatibility model.
2. Add the shared Portal-owned Python publication library, merge lock, transaction
   journal, recovery command, and focused unit tests.
3. Integrate `manager-daily-mirrors` publication after the ordinary Manager SQL Server
   clone and `manager-weekly-sdw-map` publication after the complete Saturday SDW/map
   workflow.
4. Add STM Risk Step 1100 after Step 1000 and publish the configured
   `stm-risk-intermediate` fragment.
5. Integrate producer-fragment publication with terrain, Portal serving SQLite, and
   the Manager **System Catalog** action. Remove `system.db` from semantic software
   release update types.
6. Add Portal Manager source-publication status, fragment ownership, incomplete
   transaction recovery, and validation.
7. Implement the Tauri `DataCacheManager`, local manifest, staging, validation,
   activation, progress, and cleanup.
8. Add the startup splash decision flow and offline/error states.
9. Replace physical source-path access in Rust and Python with logical resolver calls.
10. Add resource leases and version-aware PMTiles/terrain URLs.
11. Migrate resources group by group and remove direct G-drive runtime fallbacks.
12. Add status UI, structured logs, recovery tools, and complete integration tests.
13. Package and verify the final Desktop build at
    `dist\Portal-Desktop\Portal.exe`.

## 21. Testing Strategy

### 21.1 Unit tests

- manifest schema and path normalization;
- version comparison and seven-day grace calculation;
- blocking/background queue decisions;
- activation-group strictness;
- resume-state calculations;
- checksum and fingerprint failures;
- producer ownership and `desktopEnabled` filtering;
- concurrent producer-fragment merge without lost updates;
- prepared transaction recovery;
- local atomic-manifest replacement;
- lease-based cleanup;
- startup-only check enforcement.

### 21.2 Integration tests

- first startup with an empty cache;
- startup with all versions current;
- daily source updated within and beyond grace;
- ordinary Manager daily release followed by an independent Saturday group failure;
- weekly activation group with one missing member;
- STM Risk Step 1000 failure does not run Step 1100;
- STM Risk Step 1100 registration failure returns a nonzero pipeline result;
- Portal Manager and STM Risk publish concurrently without replacing each other's
  fragment entries;
- interrupted fixed-file commit is recovered from the prepared transaction journal;
- terrain group update;
- new `system.db` before authentication;
- remote share unavailable with and without valid local copies;
- interrupted and resumed multi-gigabyte copy;
- corrupt local and corrupt remote candidate;
- insufficient disk space;
- resource open during background activation;
- PMTiles cache invalidation after version switch;
- cleanup after resource lease release;
- startup during maintenance and maintenance beginning during background copy.

### 21.3 Performance tests

- manifest comparison time with all registered files;
- startup cost when nothing changed;
- sequential G-drive copy throughput;
- checksum time for large files;
- local DuckDB query time versus shared-drive access;
- PMTiles range-read latency from local cache;
- disk usage during the largest activation group.

## 22. Acceptance Criteria

The design is complete when all of the following are verified:

1. Existing Python-maintained authoritative files remain at their established paths.
2. Every producer owns an explicit output allowlist and a separate manifest fragment.
3. Every Desktop-enabled source is represented by a logical ID in one central
   manifest; unregistered outputs are not downloaded.
4. Concurrent producer publications preserve all unrelated manifest entries.
5. Portal Desktop checks the remote manifest exactly once per startup.
6. Missing, corrupt, and more-than-seven-days-behind required data is updated on the
   splash before the workspace opens.
7. A newer release within grace downloads sequentially in the background.
8. Downloads show accurate byte and overall progress and never expose partial files.
9. Activation groups switch atomically.
10. Every cache-backed resource reads the latest active local version through the
    central resolver; `portal.serving` reads the latest direct-network version through
    its atomic pointer manifest.
11. Open resources remain pinned to their original source snapshot until refresh or
   close.
12. Valid local data supports startup when the G drive is unavailable; only resources
    requiring live `portal.serving` data are unavailable while disconnected.
13. No cache-backed resource silently falls back to a direct G-drive runtime path, and
    `portal.serving` is the only permitted direct-network exception.
14. Only the newest active version remains after leases and deferred cleanup finish.
15. `system.db` is published from the Manager System Catalog page without a software
    version, registered as `system.catalog`, and consumed read-only; `stormwater.db`
    remains local and writable.
16. The Manager task publishes an independent daily mirror release on every successful
    run.
17. The weekly SDW DuckDB and four vector PMTiles archives always publish and activate
    as one consistent release.
18. STM Risk Step 1100 runs only after Step 1000 succeeds and publishes only the
    configured intermediate outputs.
19. A registration failure leaves the previous central release active and causes its
    producer workflow to report failure.
20. Interrupted manifest commits are detectable and recoverable through the
    transaction journal.
21. The DEM COG and terrain PMTiles always activate as one terrain release.
22. Portal Desktop is rebuilt and verified at `dist\Portal-Desktop\Portal.exe`.

## 23. Final Architectural Decision

Portal uses a **manifest-driven, startup-checked, local immutable source-data cache**
with one explicit direct-network source.
The existing fixed-name G-drive data products remain authoritative and continue to be
maintained by their scheduled Python workflows. Publication metadata assigns immutable
content versions without forcing those source files to move or be renamed. Each
producer owns an explicit output allowlist and atomically publishes a separate manifest
fragment. A shared Portal utility merges those fragments into the central Desktop
manifest under a short transaction lock. Portal Manager publishes independent daily
mirror and Saturday SDW/map releases, while STM Risk publishes its intermediate-data
release in Step 1100 only after Step 1000 succeeds. Desktop downloads validated
cache-backed versions to its local data folder and activates them atomically. The
sub-100-MB, five-minute `portal.serving` publication remains on the shared drive and is
resolved through its atomic pointer manifest for each operation. This provides local
performance for large data, current serving-table results, controlled freshness,
recoverable concurrent publication, and consistent multi-file releases without
changing ownership of the established data pipelines.
