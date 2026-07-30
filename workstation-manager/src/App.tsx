import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ArchiveRestore,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  Database,
  FileCog,
  FolderOpen,
  GitBranch,
  HardDriveDownload,
  History,
  LayoutDashboard,
  ListChecks,
  PackageCheck,
  Play,
  RefreshCw,
  ScrollText,
  Settings,
  ShieldAlert,
  Square,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type SyncRun = {
  status: string;
  startedAt: string;
  finishedAt: string;
  duration: string;
  details: string;
};

type SyncStatus = {
  schedulerRunning: boolean;
  startAllowed: boolean;
  scheduledTaskRegistered: boolean;
  scheduledTaskName: string;
  scheduledTaskTime: string;
  scheduledTaskState: string;
  statusText: string;
  nextRunText: string;
  publishedDatabase: string;
  latestResult: string;
  logDirectory: string;
  runs: SyncRun[];
};

type SourceDataAction = "service-start" | "service-stop" | "schedule-enable" | "schedule-disable";

type RepositoryStatus = {
  network_root: string;
  protocol_root: string;
  system_database: string;
  shared_available: boolean;
  initialized: boolean;
  membership_count: number;
  snapshot_id: string;
  snapshot_epoch_id: string;
  valid?: boolean;
  message?: string;
  missing?: string[];
};

type SchemaStatus = {
  system_database: string;
  network_root: string;
  protocol_root: string;
  active_snapshot_id: string;
  active_snapshot_epoch_id: string;
  active_snapshot_path: string;
  snapshot_created_at?: string | null;
  target_release_id?: string | null;
  target_schema_version?: number | null;
  state: string;
  installed_release_id?: string | null;
  installed_schema_version?: number | null;
  catalog_hash?: string | null;
  physical_fingerprint?: string | null;
  diagnostic?: string | null;
  last_validated_at?: string | null;
  last_migrated_at?: string | null;
  snapshot_coverage_actors?: number;
  valid?: boolean;
};

type SchemaPlan = SchemaStatus & {
  from_release_id?: string | null;
  to_release_id?: string | null;
  migrations?: Array<{
    migration_id: string;
    migration_kind: string;
    handler_name: string;
    destructive: boolean;
  }>;
};

type PortalReleaseStatus = {
  portableRoot: string;
  releaseRoot: string;
  packageVersion: string;
  currentReleaseVersion?: string | null;
  currentUpdateMode?: string | null;
  bootstrapVersion?: string | null;
  portalExe: string;
  systemDb: string;
};

type PageId =
  | "overview"
  | "source-data"
  | "repository"
  | "releases"
  | "schema"
  | "snapshots"
  | "backup"
  | "conflicts"
  | "activity"
  | "logs"
  | "settings";

type NavigationItem = {
  id: PageId;
  label: string;
  icon: LucideIcon;
};

type SnapshotInfo = {
  name: string;
  snapshot_id: string;
  path: string;
  size_bytes: number;
  created_at: string;
  is_active: boolean;
};

type SnapshotStatus = {
  active_snapshot_id: string;
  active_snapshot_epoch_id: string;
  active_snapshot_path: string;
  active_snapshot_size: number;
  snapshot_count: number;
  retention_target: number;
  retention_candidates: number;
  snapshots: SnapshotInfo[];
  operation_online_days?: number;
  automatic_enabled?: boolean;
  automatic_schedule?: string;
  eligible_package_count?: number;
  snapshot_archive_candidates?: Array<{ snapshot_id: string; path: string }>;
  missing_snapshot_backups?: string[];
  blocked_reasons?: string[];
  ready_to_archive?: boolean;
  archived_package_count?: number;
  archived_snapshot_count?: number;
  valid?: boolean;
  action?: string;
};

type RetentionScheduleStatus = {
  task_name: string;
  registered: boolean;
  state: string;
  automatic_enabled: boolean;
  schedule: string;
  message: string;
};

type NightlyScheduleStatus = RetentionScheduleStatus;

type BackupInfo = { name: string; path: string; size_bytes: number; modified_at?: string };
type BackupStatus = {
  backup_root: string;
  backup_count: number;
  latest_backup: string;
  backups: BackupInfo[];
  active_snapshot_id?: string;
  recovery_available?: boolean;
  recovery_backup_path?: string;
  recovery_reason?: string;
  verified_count?: number;
  invalid?: string[];
  verified?: boolean;
  backup_path?: string;
};

type ConflictRecord = {
  conflict_id: string;
  entity_type: string;
  entity_id: string;
  state: string;
  detected_at: string;
  selected_operation_id: string;
};

type ConflictStatus = {
  active_snapshot_id: string;
  open_count: number;
  conflicts: ConflictRecord[];
  export_path?: string;
};

type MaintenanceEvent = {
  recorded_at: string;
  task: string;
  status: string;
  details: string;
};

type LogStatus = {
  log_path: string;
  log_directory: string;
  retention_days: number;
  events: MaintenanceEvent[];
};

type ActivityOperation = {
  operation_id: string;
  tx_id: string;
  actor_id: string;
  actor_seq: number;
  user_id: string;
  user_name: string;
  employee_number: string;
  entity_type: string;
  entity_id: string;
  operation_type: string;
  created_at: string;
  package_id: string;
  package_path: string;
};

type ActivityStatus = {
  selected_date: string;
  operations: ActivityOperation[];
  operation_count: number;
  package_count: number;
  actor_count: number;
  skipped_package_count: number;
  package_root: string;
};

type SettingsStatus = {
  settings_path: string;
  network_root: string;
  system_database: string;
  backup_root: string;
  network_available: boolean;
  system_database_available: boolean;
  python_version: string;
  schema_version?: number | string | null;
};

const today = new Date().toISOString().slice(0, 10);

const navigation: NavigationItem[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "source-data", label: "Source Data", icon: Database },
  { id: "repository", label: "Repository", icon: GitBranch },
  { id: "releases", label: "Releases", icon: PackageCheck },
  { id: "schema", label: "Schema", icon: FileCog },
  { id: "snapshots", label: "Snapshots", icon: HardDriveDownload },
  { id: "backup", label: "Backup", icon: ArchiveRestore },
  { id: "conflicts", label: "Conflicts", icon: ShieldAlert },
  { id: "activity", label: "Activity", icon: History },
  { id: "logs", label: "Logs", icon: ScrollText },
  { id: "settings", label: "Settings", icon: Settings },
];

const pageDescriptions: Record<PageId, string> = {
  overview: "Monitor source synchronization and open workstation maintenance tools.",
  "source-data": "Schedule and monitor the local publication of source data for Portal.",
  repository: "Inspect and validate the shared business-data repository.",
  releases: "Publish approved portable Portal updates to the shared release location.",
  schema: "Validate and publish approved shared business-data schema snapshots.",
  snapshots: "Monitor verified business-data checkpoints and manage scheduled maintenance tasks.",
  backup: "Create and verify independent backup copies of the active shared snapshot.",
  conflicts: "Review and export data-coordinator conflict reports for follow-up in Portal.",
  activity: "Browse read-only desktop business operations published to the shared repository.",
  logs: "Browse the compact seven-day workstation task history and diagnostics.",
  settings: "Validate workstation paths, Python runtime details, and the configured shared repository.",
};


function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value + "T00:00:00"));
}

function formatTimestamp(value?: string) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(parsed);
}

function formatBytes(value?: number) {
  if (!value) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function fileName(path?: string) {
  if (!path) return "-";
  const normalized = path.replaceAll("\\", "/");
  return normalized.split("/").filter(Boolean).at(-1) || path;
}

function Overview({ status, navigate }: { status: SyncStatus | null; navigate: (page: PageId) => void }) {
  const modules = navigation.filter((item) => item.id !== "overview");
  return (
    <section className="overview-workspace">
      <section className="metrics overview-metrics">
        <div>
          <span>SOURCE TASK</span>
          <strong>{status?.scheduledTaskState ?? "Checking"}</strong>
        </div>
        <div>
          <span>LATEST RESULT</span>
          <strong>{status?.latestResult ?? "Checking"}</strong>
        </div>
        <div>
          <span>ACTIVE PUBLICATION</span>
          <strong className="path" title={status?.publishedDatabase || undefined}><Database size={16} />{fileName(status?.publishedDatabase)}</strong>
        </div>
      </section>
      <section className="module-grid" aria-label="Workstation modules">
        {modules.map((item) => {
          const Icon = item.icon;
          return (
            <button className="module-link" key={item.id} onClick={() => navigate(item.id)}>
              <Icon size={20} />
              <span>
                <strong>{item.label}</strong>
                <small>Available</small>
              </span>
            </button>
          );
        })}
      </section>
    </section>
  );
}

function SchemaWorkspace({
  status,
  plan,
  busy,
  confirmation,
  setConfirmation,
  validate,
  loadPlan,
  execute,
}: {
  status: SchemaStatus | null;
  plan: SchemaPlan | null;
  busy: string | null;
  confirmation: string;
  setConfirmation: (value: string) => void;
  validate: () => void;
  loadPlan: () => void;
  execute: (action: "initialize" | "migrate") => void;
}) {
  const requiresInitialization = status?.state === "unmanaged" || !status?.installed_release_id;
  const isHealthy = status?.state === "healthy";
  const migrations = plan?.migrations ?? [];
  const confirmationMatches = confirmation.trim() === status?.active_snapshot_id;
  const stateLabel = status?.state ? status.state.replaceAll("_", " ").toUpperCase() : "CHECKING";

  return (
    <section className="schema-workspace">
      <div className="module-actions">
        <div className="actions">
          <button className="quiet-button" disabled={busy !== null} onClick={validate}>
            <CheckCircle2 size={17} />
            {busy === "validate" ? "Validating" : "Validate"}
          </button>
          <button className="primary-button" disabled={busy !== null} onClick={loadPlan}>
            <ListChecks size={17} />
            {busy === "plan" ? "Planning" : "Plan"}
          </button>
        </div>
      </div>

      <section className={isHealthy ? "status running compact-status" : "status stopped compact-status"}>
        <div>
          <p className="eyebrow">SCHEMA STATUS</p>
          <h2>{stateLabel}</h2>
        </div>
      </section>

      <section className="metrics schema-metrics" aria-label="Shared schema status">
        <div><span>PUBLISHED RELEASE</span><strong>{status?.installed_release_id || "Unmanaged"}</strong></div>
        <div><span>ACTIVE SNAPSHOT</span><strong>{status?.active_snapshot_id || "Checking"}</strong></div>
        <div><span>SCHEMA VERSION</span><strong>{status?.installed_schema_version ?? status?.target_schema_version ?? "-"}</strong></div>
      </section>

      <section className="schema-details">
        <div><span>System catalog</span><strong>{status?.system_database || "Checking configuration"}</strong></div>
        <div><span>Shared repository</span><strong>{status?.network_root || "Checking configuration"}</strong></div>
        <div><span>Protocol root</span><strong>{status?.protocol_root || "Checking configuration"}</strong></div>
        <div><span>Active snapshot</span><strong title={status?.active_snapshot_path || undefined}>{status?.active_snapshot_id || "Checking configuration"}</strong></div>
        <div><span>Catalog hash</span><strong>{status?.catalog_hash || "-"}</strong></div>
      </section>

      <section className="schema-plan" aria-label="Schema migration plan">
        <div className="table-toolbar">
          <div>
            <p className="eyebrow">MIGRATION PLAN</p>
            <h2>{plan ? `${plan.from_release_id || "Unmanaged"} to ${plan.to_release_id || "Active release"}` : "Load a plan before changing the database"}</h2>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Migration</th><th>Kind</th><th>Handler</th><th>Data rebuild</th></tr></thead>
            <tbody>
              {migrations.map((migration) => (
                <tr key={migration.migration_id}>
                  <td>{migration.migration_id}</td><td>{migration.migration_kind}</td><td>{migration.handler_name}</td><td>{migration.destructive ? "Yes" : "No"}</td>
                </tr>
              ))}
              {plan && !migrations.length && <tr><td colSpan={4} className="empty compact-empty">No migration is required for the active release.</td></tr>}
              {!plan && <tr><td colSpan={4} className="empty compact-empty">No migration plan has been loaded.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="schema-actions">
        <div>
          <p className="eyebrow">CONFIRM SHARED SCHEMA PUBLICATION</p>
          <p>Type the active snapshot ID. Publishing creates a verified replacement snapshot and briefly blocks formal saves.</p>
        </div>
        <input aria-label="Active snapshot ID confirmation" value={confirmation} placeholder={status?.active_snapshot_id || "Active snapshot ID"} onChange={(event) => setConfirmation(event.target.value)} />
        <div className="actions">
          <button className="primary-button" disabled={!requiresInitialization || !confirmationMatches || busy !== null} onClick={() => execute("initialize")}>
            <Wrench size={17} /> {busy === "initialize" ? "Publishing" : "Publish baseline"}
          </button>
          <button className="primary-button" disabled={requiresInitialization || !migrations.length || !confirmationMatches || busy !== null} onClick={() => execute("migrate")}>
            <FileCog size={17} /> {busy === "migrate" ? "Publishing" : "Publish migration"}
          </button>
        </div>
      </section>
    </section>
  );
}

function RepositoryWorkspace({
  status,
  busy,
  networkRoot,
  setNetworkRoot,
  refresh,
  validate,
  bootstrap,
}: {
  status: RepositoryStatus | null;
  busy: "refresh" | "validate" | "bootstrap" | null;
  networkRoot: string;
  setNetworkRoot: (value: string) => void;
  refresh: () => void;
  validate: () => void;
  bootstrap: (networkRoot: string) => void;
}) {
  const initialized = status?.initialized ?? false;
  const sharedAvailable = status?.shared_available ?? false;
  return (
    <section className="repository-workspace">
      <div className="module-actions">
        <div className="actions">
          <button className="primary-button" disabled={!initialized || busy !== null} onClick={validate}>
            <ShieldAlert size={17} />
            {busy === "validate" ? "Validating" : "Validate"}
          </button>
        </div>
      </div>

      <section className={sharedAvailable ? "status running" : "status stopped"}>
        <div>
          <p className="eyebrow">REPOSITORY STATUS</p>
          <h2>{initialized ? "INITIALIZED" : sharedAvailable ? "NOT INITIALIZED" : "UNAVAILABLE"}</h2>
          <p>{status?.message ?? (sharedAvailable ? "The shared location is available." : "Checking the configured shared location.")}</p>
        </div>
      </section>

      <section className="metrics repository-metrics" aria-label="Repository status">
        <div>
          <span>MEMBERS</span>
          <strong>{status?.membership_count ?? "-"}</strong>
        </div>
        <div>
          <span>ACTIVE SNAPSHOT</span>
          <strong>{status?.snapshot_id || "-"}</strong>
        </div>
        <div>
          <span>SNAPSHOT EPOCH</span>
          <strong>{status?.snapshot_epoch_id || "-"}</strong>
        </div>
      </section>

      <section className="repository-details">
        <div><span>Shared repository</span><strong>{status?.network_root ?? "Checking configuration"}</strong></div>
        <div><span>Protocol root</span><strong>{status?.protocol_root ?? "-"}</strong></div>
        <div><span>System database</span><strong>{status?.system_database ?? "-"}</strong></div>
      </section>

      {!initialized && sharedAvailable && (
        <section className="repository-bootstrap">
          <div>
            <p className="eyebrow">INITIALIZE REPOSITORY</p>
            <h3>Shared repository path</h3>
            <p>Initialization creates the shared protocol structure and initial membership release. Change the configured path here when needed.</p>
          </div>
          <div className="bootstrap-controls">
            <input
              aria-label="Shared repository path"
              value={networkRoot}
              placeholder="Shared repository path"
              onChange={(event) => setNetworkRoot(event.target.value)}
            />
            <button
              className="danger-button"
              disabled={busy !== null || !networkRoot.trim()}
              onClick={() => bootstrap(networkRoot.trim())}
            >
              <Database size={17} />
              {busy === "bootstrap" ? "Initializing" : "Initialize"}
            </button>
          </div>
        </section>
      )}
    </section>
  );
}

function ReleaseWorkspace({
  status,
  updateMode,
  releaseVersion,
  busy,
  progress,
  success,
  setUpdateMode,
  setReleaseVersion,
  publish,
}: {
  status: PortalReleaseStatus | null;
  updateMode: "system-db" | "portal-exe" | "full";
  releaseVersion: string;
  busy: boolean;
  progress: string;
  success: string;
  setUpdateMode: (value: "system-db" | "portal-exe" | "full") => void;
  setReleaseVersion: (value: string) => void;
  publish: () => void;
}) {
  const targeted = updateMode !== "full";
  return (
    <section className="release-workspace">
      <section className="metrics release-metrics" aria-label="Portal release status">
        <div><span>PACKAGE VERSION</span><strong>{status?.packageVersion ?? "-"}</strong></div>
        <div><span>CURRENT RELEASE</span><strong>{status?.currentReleaseVersion ?? "Not published"}</strong></div>
        <div><span>BOOTSTRAP BUNDLE</span><strong>{status?.bootstrapVersion ?? "Not published"}</strong></div>
      </section>

      <section className="release-details">
        <div><span>Portable folder</span><strong>{status?.portableRoot ?? "Checking configuration"}</strong></div>
        <div><span>Release folder</span><strong>{status?.releaseRoot ?? "-"}</strong></div>
        <div><span>System database</span><strong>{status?.systemDb ?? "-"}</strong></div>
        <div><span>Portal executable</span><strong>{status?.portalExe ?? "-"}</strong></div>
      </section>

      <section className="release-controls">
        <div>
          <p className="eyebrow">PUBLISH UPDATE</p>
          <h3>Select the exact update type</h3>
          <p>A full release is required for the Python runtime, multiple files, or structural changes.</p>
        </div>
        <label>
          Update type
          <select value={updateMode} onChange={(event) => setUpdateMode(event.target.value as typeof updateMode)}>
            <option value="system-db">System database only</option>
            <option value="portal-exe">Portal executable only</option>
            <option value="full">Full portable folder</option>
          </select>
        </label>
        <label>
          Release version
          <input
            value={releaseVersion}
            placeholder={status?.packageVersion ?? "0.0.0"}
            onChange={(event) => setReleaseVersion(event.target.value)}
          />
        </label>
        <button
          className="primary-button"
          disabled={busy || !status || (targeted && !releaseVersion.trim())}
          onClick={publish}
        >
          <PackageCheck size={17} />
          {busy ? "Publishing" : "Publish release"}
        </button>
      </section>

      {busy && (
        <section className="release-feedback progress" aria-live="polite">
          <RefreshCw size={19} className="spin" />
          <div>
            <strong>Publishing release</strong>
            <p>{progress || "Preparing the release."}</p>
          </div>
        </section>
      )}
      {!busy && success && (
        <section className="release-feedback success" aria-live="polite">
          <CheckCircle2 size={20} />
          <div>
            <strong>Release published successfully</strong>
            <p>{success}</p>
          </div>
        </section>
      )}
    </section>
  );
}

function SourceDataWorkspace({
  status,
  selectedDate,
  setSelectedDate,
  busy,
  execute,
  openLogs,
}: {
  status: SyncStatus | null;
  selectedDate: string;
  setSelectedDate: (date: string) => void;
  busy: SourceDataAction | null;
  execute: (action: SourceDataAction) => void;
  openLogs: () => void;
}) {
  const scheduleRegistered = status?.scheduledTaskRegistered ?? false;
  const taskState = status?.scheduledTaskState ?? "Checking";
  const serviceRunning = status?.schedulerRunning ?? false;
  return (
    <section className="source-workspace table-focused-workspace">
      <section className={serviceRunning ? "status running" : "status stopped"}>
        <div>
          <p className="eyebrow">SOURCE DATA SERVICE</p>
          <h2>{serviceRunning ? "RUNNING" : "STOPPED"}</h2>
          <p>{serviceRunning ? "The source data scheduler is running on this workstation." : "The source data scheduler is not running on this workstation."}</p>
        </div>
        <div className="actions">
          <button className="primary-button" disabled={busy !== null || serviceRunning || !status?.startAllowed} onClick={() => execute("service-start")}><Play size={17} />{busy === "service-start" ? "Starting" : "Start"}</button>
          <button className="danger-button" disabled={busy !== null || !serviceRunning} onClick={() => execute("service-stop")}><Square size={16} />{busy === "service-stop" ? "Stopping" : "Stop"}</button>
          {scheduleRegistered ? <button className="quiet-button" disabled={busy !== null} onClick={() => execute("schedule-disable")}><CalendarClock size={17} />{busy === "schedule-disable" ? "Removing" : "Disable automatic"}</button> : <button className="primary-button" disabled={busy !== null} onClick={() => execute("schedule-enable")}><CalendarClock size={17} />{busy === "schedule-enable" ? "Enabling" : "Enable automatic"}</button>}
          <button className="quiet-button" onClick={openLogs} disabled={!status?.logDirectory}>
            <FolderOpen size={17} />
            Open logs
          </button>
        </div>
      </section>

      <section className="metrics" aria-label="Source synchronization status">
        <div>
          <span>SERVICE STATE</span>
          <strong>{serviceRunning ? "Running" : "Stopped"}</strong>
        </div>
        <div>
          <span>AUTOMATIC TASK</span>
          <strong>{scheduleRegistered ? `${taskState} - ${status?.scheduledTaskTime ?? "Daily schedule"}` : "Not registered"}</strong>
        </div>
        <div>
          <span>PUBLISHED DATABASE</span>
          <strong className="path" title={status?.publishedDatabase || undefined}><Database size={16} />{fileName(status?.publishedDatabase)}</strong>
        </div>
        <div>
          <span>LATEST RESULT</span>
          <strong>{status?.latestResult ?? "No runs recorded"}</strong>
        </div>
      </section>

      <section className="runs">
        <div className="table-toolbar">
          <div>
            <p className="eyebrow">SYNCHRONIZATION RUNS</p>
            <h2>{formatDate(selectedDate)}</h2>
          </div>
          <label>
            Date
            <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
          </label>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Started</th>
                <th>Finished</th>
                <th>Duration</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {(status?.runs ?? []).map((run, index) => (
                <tr key={[run.startedAt, index].join("-")}>
                  <td data-status={run.status}>{run.status}</td>
                  <td>{run.startedAt}</td>
                  <td>{run.finishedAt}</td>
                  <td>{run.duration}</td>
                  <td>{run.details}</td>
                </tr>
              ))}
              {!status?.runs.length && (
                <tr>
                  <td colSpan={5} className="empty">No synchronization attempts were recorded for this date.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

function SnapshotWorkspace({
  status,
  schedule,
  nightlySchedule,
  busy,
  execute,
  openLocation,
}: {
  status: SnapshotStatus | null;
  schedule: RetentionScheduleStatus | null;
  nightlySchedule: NightlyScheduleStatus | null;
  busy: string | null;
  execute: (action: "schedule-enable" | "schedule-disable" | "nightly-schedule-enable" | "nightly-schedule-disable") => void;
  openLocation: (path: string) => void;
}) {
  return (
    <section className="maintenance-workspace table-focused-workspace">
      <section className="status running compact-status">
        <div>
          <p className="eyebrow">ACTIVE SNAPSHOT</p>
          <h2>{status?.active_snapshot_id || "CHECKING"}</h2>
        </div>
      </section>
      <section className="metrics maintenance-metrics">
        <div><span>SNAPSHOTS</span><strong>{status?.snapshot_count ?? "-"}</strong></div>
        <div><span>RETENTION TARGET</span><strong>{status?.retention_target ?? "-"}</strong></div>
        <div><span>RETENTION CANDIDATES</span><strong>{status?.retention_candidates ?? "-"}</strong></div>
        <div><span>ACTIVE SIZE</span><strong>{formatBytes(status?.active_snapshot_size)}</strong></div>
      </section>
      <section className="maintenance-details snapshot-active-details">
        <div><span>Active snapshot</span><strong title={status?.active_snapshot_path || undefined}>{status?.active_snapshot_id || "Checking configuration"}</strong></div>
        <div><span>Epoch</span><strong>{status?.active_snapshot_epoch_id || "-"}</strong></div>
      </section>
      <section className="retention-controls scheduled-task-controls">
        <div className="retention-readout"><span>Task state</span><strong>{nightlySchedule?.state || "Checking"}</strong></div>
        <div className="retention-readout"><span>Scheduled run</span><strong>{nightlySchedule?.schedule || "Daily 02:00 local time"}</strong></div>
        <div className="retention-schedule-action">{nightlySchedule?.registered ? <button className="quiet-button" disabled={busy !== null} onClick={() => execute("nightly-schedule-disable")}><CalendarClock size={17} />{busy === "nightly-schedule-disable" ? "Removing" : "Disable"}</button> : <button className="quiet-button" disabled={busy !== null || !nightlySchedule?.automatic_enabled} onClick={() => execute("nightly-schedule-enable")}><CalendarClock size={17} />{busy === "nightly-schedule-enable" ? "Enabling" : "Enable"}</button>}</div>
        <p className="nightly-note">Publishes one verified checkpoint. Backups and retention run only in the Friday maintenance task.</p>
      </section>
      <section className="retention-controls scheduled-task-controls">
        <div className="retention-readout"><span>Task state</span><strong>{schedule?.state || "Checking"}</strong></div>
        <div className="retention-readout"><span>Scheduled run</span><strong>{schedule?.schedule || status?.automatic_schedule || "Checking configuration"}</strong></div>
        <div className="retention-schedule-action">{schedule?.registered ? <button className="quiet-button" disabled={busy !== null} onClick={() => execute("schedule-disable")}><CalendarClock size={17} />{busy === "schedule-disable" ? "Removing" : "Disable"}</button> : <button className="quiet-button" disabled={busy !== null || !schedule?.automatic_enabled} onClick={() => execute("schedule-enable")}><CalendarClock size={17} />{busy === "schedule-enable" ? "Enabling" : "Enable"}</button>}</div>
        <p className="nightly-note">Creates and verifies the protected backups, archives eligible online packages, and removes backup artifacts older than 90 days.</p>
      </section>
      <section className="maintenance-table">
        <div className="table-toolbar"><div><p className="eyebrow">SNAPSHOT HISTORY</p><h2>Verified shared snapshots</h2></div></div>
        <div className="table-scroll"><table className="snapshot-history-table"><thead><tr><th>Created</th><th>Snapshot ID</th><th>Size</th><th>Status</th><th>Location</th></tr></thead><tbody>
          {(status?.snapshots ?? []).map((snapshot) => <tr key={snapshot.path}><td>{formatTimestamp(snapshot.created_at)}</td><td title={snapshot.path}>{snapshot.snapshot_id}</td><td>{formatBytes(snapshot.size_bytes)}</td><td data-status={snapshot.is_active ? "Succeeded" : ""}>{snapshot.is_active ? "Active" : "Retained"}</td><td><button className="text-button" onClick={() => openLocation(snapshot.path)}>Open location</button></td></tr>)}
          {!status?.snapshots.length && <tr><td colSpan={5} className="empty compact-empty">No snapshots were found.</td></tr>}
        </tbody></table></div>
      </section>
    </section>
  );
}

function BackupWorkspace({ status, busy, execute, restore, openPath }: { status: BackupStatus | null; busy: string | null; execute: () => void; restore: (confirmation: string) => void; openPath: (path: string) => void }) {
  const [pageSize, setPageSize] = useState(25);
  const [currentPage, setCurrentPage] = useState(1);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [restoreConfirmation, setRestoreConfirmation] = useState("");
  const backups = useMemo(() => [...(status?.backups ?? [])].sort((left, right) => {
    const leftTime = left.modified_at ? new Date(left.modified_at).getTime() : 0;
    const rightTime = right.modified_at ? new Date(right.modified_at).getTime() : 0;
    return sortDirection === "desc" ? rightTime - leftTime : leftTime - rightTime;
  }), [status?.backups, sortDirection]);
  const totalPages = Math.max(1, Math.ceil(backups.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const firstResult = backups.length ? (safePage - 1) * pageSize + 1 : 0;
  const lastResult = Math.min(safePage * pageSize, backups.length);
  const pageBackups = backups.slice(firstResult - 1, lastResult);

  useEffect(() => {
    setCurrentPage(1);
  }, [status?.backups, pageSize, sortDirection]);

  return (
    <section className="maintenance-workspace table-focused-workspace">
      <div className="module-actions"><div className="actions">
        <button className="quiet-button" disabled={busy !== null} onClick={execute}><CheckCircle2 size={17} />{busy === "verify" ? "Verifying" : "Verify backups"}</button>
        <button className="quiet-button" disabled={!status?.backup_root} onClick={() => openPath(status?.backup_root || "")}><FolderOpen size={17} />Open backups</button>
      </div></div>
      <section className="status running compact-status"><div><p className="eyebrow">INDEPENDENT BACKUPS</p><h2>{status?.backup_count ?? "-"} BACKUPS</h2></div></section>
      <section className="metrics maintenance-metrics"><div><span>BACKUP COUNT</span><strong>{status?.backup_count ?? "-"}</strong></div><div><span>VERIFIED</span><strong>{status?.verified_count ?? "-"}</strong></div><div><span>INVALID</span><strong>{status?.invalid?.length ?? "-"}</strong></div><div><span>LATEST</span><strong>{status?.latest_backup ? "Available" : "None"}</strong></div></section>
      <section className="maintenance-details backup-policy-details"><div><span>Backup folder</span><strong>{status?.backup_root || "Checking configuration"}</strong></div><div><span>Policy</span><strong>Generated and retained by the Friday automatic retention task for 90 days.</strong></div></section>
      <section className="maintenance-confirmation backup-recovery">
        <div className="backup-recovery-copy"><p className="eyebrow">EMERGENCY RECOVERY</p><p>Repair a missing or corrupt active snapshot from an exact verified backup.</p><span className="recovery-status">{status?.recovery_reason || "Checking recovery availability."}</span></div>
        <input value={restoreConfirmation} onChange={(event) => setRestoreConfirmation(event.target.value)} placeholder={status?.active_snapshot_id || "Active snapshot ID"} aria-label="Active snapshot ID confirmation" />
        <div className="maintenance-confirmation-actions"><button className="danger-button" disabled={busy !== null || !status?.recovery_available || restoreConfirmation.trim() !== status?.active_snapshot_id} onClick={() => restore(restoreConfirmation)}><ArchiveRestore size={17} />{busy === "restore" ? "Restoring" : "Restore active snapshot"}</button></div>
      </section>
      <section className="maintenance-table backup-inventory-table"><div className="table-toolbar"><div><p className="eyebrow">BACKUP INVENTORY</p><h2>{backups.length} verified copies</h2></div></div><div className="table-scroll"><table><thead><tr><th><button className="table-sort-button" onClick={() => setSortDirection((value) => value === "desc" ? "asc" : "desc")}>Backup date {sortDirection === "desc" ? "DESC" : "ASC"}</button></th><th>Backup</th><th>Size</th><th>Location</th></tr></thead><tbody>
        {pageBackups.map((backup) => <tr key={backup.path}><td>{formatTimestamp(backup.modified_at)}</td><td>{backup.name}</td><td>{formatBytes(backup.size_bytes)}</td><td><button className="text-button" onClick={() => openPath(backup.path)}>Open location</button></td></tr>)}
        {!backups.length && <tr><td colSpan={4} className="empty compact-empty">No backup files were found.</td></tr>}
      </tbody></table></div><footer className="activity-pagination"><label>Rows<select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>{[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</select></label><strong>{firstResult}-{lastResult} of {backups.length}</strong><div><button className="quiet-button icon-button" aria-label="First page" disabled={safePage === 1} onClick={() => setCurrentPage(1)}><ChevronsLeft size={16} /></button><button className="quiet-button icon-button" aria-label="Previous page" disabled={safePage === 1} onClick={() => setCurrentPage(safePage - 1)}><ChevronLeft size={16} /></button><span>Page {safePage} of {totalPages}</span><button className="quiet-button icon-button" aria-label="Next page" disabled={safePage === totalPages} onClick={() => setCurrentPage(safePage + 1)}><ChevronRight size={16} /></button><button className="quiet-button icon-button" aria-label="Last page" disabled={safePage === totalPages} onClick={() => setCurrentPage(totalPages)}><ChevronsRight size={16} /></button></div></footer></section>
    </section>
  );
}

function ConflictWorkspace({ status, busy, exportConflicts, openPath }: { status: ConflictStatus | null; busy: string | null; exportConflicts: () => void; openPath: (path: string) => void }) {
  return (
    <section className="maintenance-workspace table-focused-workspace">
      <div className="module-actions"><div className="actions"><button className="primary-button" disabled={busy !== null} onClick={exportConflicts}><HardDriveDownload size={17} />{busy === "export" ? "Exporting" : "Export CSV"}</button></div></div>
      <section className={status?.open_count ? "status stopped compact-status" : "status running compact-status"}><div><p className="eyebrow">CONFLICT STATUS</p><h2>{status?.open_count ?? "-"} OPEN</h2></div></section>
      <section className="metrics maintenance-metrics"><div><span>OPEN</span><strong>{status?.open_count ?? "-"}</strong></div><div><span>ALL CONFLICTS</span><strong>{status?.conflicts.length ?? "-"}</strong></div><div><span>ACTIVE SNAPSHOT</span><strong>{status?.active_snapshot_id || "-"}</strong></div><div><span>EXPORT</span><strong>{status?.export_path ? "Ready" : "-"}</strong></div></section>
      <section className="maintenance-table"><div className="table-toolbar"><div><p className="eyebrow">CONFLICT LIST</p><h2>Shared snapshot conflicts</h2></div>{status?.export_path && <button className="quiet-button" onClick={() => openPath(status.export_path!)}><FolderOpen size={17} />Open export</button>}</div><div className="table-scroll"><table><thead><tr><th>Conflict</th><th>Entity type</th><th>Entity ID</th><th>State</th><th>Detected</th><th>Selected operation</th></tr></thead><tbody>
        {(status?.conflicts ?? []).map((conflict) => <tr key={conflict.conflict_id}><td>{conflict.conflict_id}</td><td>{conflict.entity_type}</td><td>{conflict.entity_id}</td><td data-status={conflict.state === "open" ? "Failed" : "Succeeded"}>{conflict.state}</td><td>{conflict.detected_at}</td><td>{conflict.selected_operation_id || "-"}</td></tr>)}
        {!status?.conflicts.length && <tr><td colSpan={6} className="empty">No conflicts were found in the active snapshot.</td></tr>}
      </tbody></table></div></section>
    </section>
  );
}

function LogsWorkspace({ status, busy, selectedDate, setSelectedDate, openPath }: { status: LogStatus | null; busy: boolean; selectedDate: string; setSelectedDate: (value: string) => void; openPath: (path: string) => void }) {
  return <section className="maintenance-workspace table-focused-workspace"><div className="module-actions"><div className="actions"><button className="quiet-button" disabled={!status?.log_directory} onClick={() => openPath(status?.log_directory || "")}><FolderOpen size={17} />Open log folder</button></div></div><section className="metrics maintenance-metrics"><div><span>EVENTS</span><strong>{status?.events.length ?? "-"}</strong></div><div><span>RETENTION</span><strong>{status?.retention_days ?? "-"} days</strong></div><div><span>DATE</span><strong>{formatDate(selectedDate)}</strong></div><div><span>LOG FILE</span><strong>{busy ? "Loading" : status?.log_path ? "Available" : "Checking"}</strong></div></section><section className="maintenance-table"><div className="table-toolbar"><div><p className="eyebrow">WORKSTATION EVENTS</p><h2>{formatDate(selectedDate)}</h2></div><label>Date<input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} /></label></div><div className="table-scroll"><table><thead><tr><th>Recorded</th><th>Task</th><th>Status</th><th>Details</th></tr></thead><tbody>{(status?.events ?? []).map((event, index) => <tr key={`${event.recorded_at}-${index}`}><td>{event.recorded_at}</td><td>{event.task}</td><td data-status={event.status}>{event.status}</td><td>{event.details}</td></tr>)}{!status?.events.length && <tr><td colSpan={4} className="empty">No workstation events were recorded for this date.</td></tr>}</tbody></table></div></section></section>;
}

function ActivityWorkspace({ status, selectedDate, setSelectedDate, openPath, openFileLocation }: { status: ActivityStatus | null; selectedDate: string; setSelectedDate: (value: string) => void; openPath: (path: string) => void; openFileLocation: (path: string) => void }) {
  const [userFilter, setUserFilter] = useState("all");
  const [operationFilter, setOperationFilter] = useState("all");
  const [entityTypeFilter, setEntityTypeFilter] = useState("all");
  const [searchFilter, setSearchFilter] = useState("");
  const [pageSize, setPageSize] = useState(50);
  const [currentPage, setCurrentPage] = useState(1);
  const operationLabel = (value: string) => value.replaceAll("_", " ");
  const operations = status?.operations ?? [];
  const users = useMemo(() => [...new Set(operations.map((operation) => operation.user_name || operation.user_id).filter(Boolean))].sort(), [operations]);
  const operationTypes = useMemo(() => [...new Set(operations.map((operation) => operation.operation_type).filter(Boolean))].sort(), [operations]);
  const entityTypes = useMemo(() => [...new Set(operations.map((operation) => operation.entity_type).filter(Boolean))].sort(), [operations]);
  const visibleOperations = useMemo(() => {
    const search = searchFilter.trim().toLowerCase();
    return operations.filter((operation) => {
      const user = operation.user_name || operation.user_id;
      if (userFilter !== "all" && user !== userFilter) return false;
      if (operationFilter !== "all" && operation.operation_type !== operationFilter) return false;
      if (entityTypeFilter !== "all" && operation.entity_type !== entityTypeFilter) return false;
      if (!search) return true;
      return [operation.entity_id, operation.tx_id, operation.package_id, operation.actor_id, operation.employee_number]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(search));
    });
  }, [operations, userFilter, operationFilter, entityTypeFilter, searchFilter]);
  const totalPages = Math.max(1, Math.ceil(visibleOperations.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const firstResult = visibleOperations.length ? (safePage - 1) * pageSize + 1 : 0;
  const lastResult = Math.min(safePage * pageSize, visibleOperations.length);
  const pageOperations = visibleOperations.slice(firstResult - 1, lastResult);
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedDate, userFilter, operationFilter, entityTypeFilter, searchFilter, pageSize]);
  const clearFilters = () => {
    setUserFilter("all");
    setOperationFilter("all");
    setEntityTypeFilter("all");
    setSearchFilter("");
  };
  return (
    <section className="maintenance-workspace table-focused-workspace">
      <section className="status running activity-status compact-status"><div><p className="eyebrow">DESKTOP BUSINESS ACTIVITY</p><h2>{status?.operation_count ?? "-"} OPERATIONS</h2></div></section>
      <section className="metrics maintenance-metrics"><div><span>OPERATIONS</span><strong>{status?.operation_count ?? "-"}</strong></div><div><span>PACKAGES</span><strong>{status?.package_count ?? "-"}</strong></div><div><span>ACTORS</span><strong>{status?.actor_count ?? "-"}</strong></div><div><span>SKIPPED PACKAGES</span><strong>{status?.skipped_package_count ?? "-"}</strong></div></section>
      <section className="maintenance-table">
        <div className="table-toolbar"><div><p className="eyebrow">PUBLISHED OPERATIONS</p><h2>{visibleOperations.length} of {operations.length} shown - {formatDate(selectedDate)}</h2></div><div className="toolbar-actions"><label>Date<input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} /></label><button className="quiet-button" disabled={!status?.package_root} onClick={() => openPath(status?.package_root || "")}><FolderOpen size={17} />Open packages</button></div></div>
        <div className="activity-filters">
          <label>User<select value={userFilter} onChange={(event) => setUserFilter(event.target.value)}><option value="all">All users</option>{users.map((user) => <option key={user} value={user}>{user}</option>)}</select></label>
          <label>Operation<select value={operationFilter} onChange={(event) => setOperationFilter(event.target.value)}><option value="all">All operations</option>{operationTypes.map((operation) => <option key={operation} value={operation}>{operationLabel(operation)}</option>)}</select></label>
          <label>Entity type<select value={entityTypeFilter} onChange={(event) => setEntityTypeFilter(event.target.value)}><option value="all">All entity types</option>{entityTypes.map((entityType) => <option key={entityType} value={entityType}>{entityType}</option>)}</select></label>
          <label className="activity-search">Search<input value={searchFilter} onChange={(event) => setSearchFilter(event.target.value)} placeholder="Entity ID, transaction, package, employee ID" /></label>
          <button className="quiet-button" onClick={clearFilters}>Clear filters</button>
        </div>
        <div className="table-scroll"><table className="activity-table"><thead><tr><th>Time</th><th>User</th><th>Employee ID</th><th>Operation</th><th>Entity Type</th><th>Entity ID</th><th>Transaction</th><th>Package</th></tr></thead><tbody>{pageOperations.map((operation) => <tr key={operation.operation_id}><td>{formatTimestamp(operation.created_at)}</td><td>{operation.user_name || operation.user_id}</td><td>{operation.employee_number || "-"}</td><td>{operationLabel(operation.operation_type)}</td><td>{operation.entity_type}</td><td>{operation.entity_id}</td><td>{operation.tx_id}</td><td><button className="text-button" onClick={() => openFileLocation(operation.package_path)}>Open package</button></td></tr>)}{!visibleOperations.length && <tr><td colSpan={8} className="empty">No desktop business operations match the selected filters.</td></tr>}</tbody></table></div>
        <footer className="activity-pagination"><label>Rows<select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>{[25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</select></label><strong>{firstResult}-{lastResult} of {visibleOperations.length}</strong><div><button className="quiet-button icon-button" aria-label="First page" disabled={safePage === 1} onClick={() => setCurrentPage(1)}><ChevronsLeft size={16} /></button><button className="quiet-button icon-button" aria-label="Previous page" disabled={safePage === 1} onClick={() => setCurrentPage(safePage - 1)}><ChevronLeft size={16} /></button><span>Page {safePage} of {totalPages}</span><button className="quiet-button icon-button" aria-label="Next page" disabled={safePage === totalPages} onClick={() => setCurrentPage(safePage + 1)}><ChevronRight size={16} /></button><button className="quiet-button icon-button" aria-label="Last page" disabled={safePage === totalPages} onClick={() => setCurrentPage(totalPages)}><ChevronsRight size={16} /></button></div></footer>
      </section>
    </section>
  );
}

function SettingsWorkspace({ status, busy, networkRoot, setNetworkRoot, save }: { status: SettingsStatus | null; busy: boolean; networkRoot: string; setNetworkRoot: (value: string) => void; save: () => void }) {
  return <section className="maintenance-workspace"><section className={status?.network_available && status?.system_database_available ? "status running" : "status stopped"}><div><p className="eyebrow">WORKSTATION SETTINGS</p><h2>{status?.network_available && status?.system_database_available ? "VALID" : "REVIEW REQUIRED"}</h2><p>Settings are read from the Portal portable configuration. The shared repository path can be changed only after the new path is available.</p></div></section><section className="metrics maintenance-metrics"><div><span>SHARED REPOSITORY</span><strong>{status?.network_available ? "Available" : "Unavailable"}</strong></div><div><span>SYSTEM CATALOG</span><strong>{status?.system_database_available ? "Available" : "Unavailable"}</strong></div><div><span>PYTHON</span><strong>{status?.python_version || "-"}</strong></div><div><span>SETTINGS VERSION</span><strong>{status?.schema_version ?? "-"}</strong></div></section><section className="maintenance-details"><div><span>Portal settings</span><strong>{status?.settings_path || "Checking configuration"}</strong></div><div><span>System database</span><strong>{status?.system_database || "-"}</strong></div><div><span>Backup folder</span><strong>{status?.backup_root || "-"}</strong></div></section><section className="maintenance-confirmation"><div><p className="eyebrow">SHARED REPOSITORY</p><p>Update only when the Portal shared repository was intentionally moved. The path must already be accessible.</p></div><input value={networkRoot} onChange={(event) => setNetworkRoot(event.target.value)} placeholder="Shared repository path" /><button className="primary-button" disabled={busy || !networkRoot.trim()} onClick={save}><Settings size={17} />{busy ? "Saving" : "Save path"}</button></section></section>;
}

export function App() {
  const [activePage, setActivePage] = useState<PageId>("overview");
  const [selectedDate, setSelectedDate] = useState(today);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [repositoryStatus, setRepositoryStatus] = useState<RepositoryStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<SourceDataAction | null>(null);
  const [repositoryBusy, setRepositoryBusy] = useState<"refresh" | "validate" | "bootstrap" | null>(null);
  const [repositoryNetworkRoot, setRepositoryNetworkRoot] = useState("");
  const [releaseStatus, setReleaseStatus] = useState<PortalReleaseStatus | null>(null);
  const [releaseMode, setReleaseMode] = useState<"system-db" | "portal-exe" | "full">("full");
  const [releaseVersion, setReleaseVersion] = useState("");
  const [releaseBusy, setReleaseBusy] = useState(false);
  const [releaseProgress, setReleaseProgress] = useState("");
  const [releaseSuccess, setReleaseSuccess] = useState("");
  const [schemaStatus, setSchemaStatus] = useState<SchemaStatus | null>(null);
  const [schemaPlan, setSchemaPlan] = useState<SchemaPlan | null>(null);
  const [schemaBusy, setSchemaBusy] = useState<string | null>(null);
  const [schemaConfirmation, setSchemaConfirmation] = useState("");
  const [snapshotStatus, setSnapshotStatus] = useState<SnapshotStatus | null>(null);
  const [retentionScheduleStatus, setRetentionScheduleStatus] = useState<RetentionScheduleStatus | null>(null);
  const [nightlyScheduleStatus, setNightlyScheduleStatus] = useState<NightlyScheduleStatus | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState<string | null>(null);
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [backupBusy, setBackupBusy] = useState<string | null>(null);
  const [conflictStatus, setConflictStatus] = useState<ConflictStatus | null>(null);
  const [conflictBusy, setConflictBusy] = useState<string | null>(null);
  const [logStatus, setLogStatus] = useState<LogStatus | null>(null);
  const [logBusy, setLogBusy] = useState(false);
  const [logDate, setLogDate] = useState(today);
  const [activityStatus, setActivityStatus] = useState<ActivityStatus | null>(null);
  const [activityDate, setActivityDate] = useState(today);
  const [settingsStatus, setSettingsStatus] = useState<SettingsStatus | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsNetworkRoot, setSettingsNetworkRoot] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await invoke<SyncStatus>("sync_status", { selectedDate });
      setStatus(response);
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }, [selectedDate]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<string>("portal-release-progress", (event) => {
      setReleaseProgress(event.payload);
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => unlisten?.();
  }, []);

  const refreshRepository = useCallback(async () => {
    setRepositoryBusy("refresh");
    try {
      const response = await invoke<RepositoryStatus>("repository_status");
      setRepositoryStatus(response);
      setRepositoryNetworkRoot(response.network_root);
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRepositoryBusy(null);
    }
  }, []);

  useEffect(() => {
    if (activePage === "repository") {
      void refreshRepository();
    }
  }, [activePage, refreshRepository]);

  const refreshRelease = useCallback(async () => {
    try {
      const response = await invoke<PortalReleaseStatus>("portal_release_status");
      setReleaseStatus(response);
      setReleaseVersion((current) => current || response.packageVersion);
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }, []);

  useEffect(() => {
    if (activePage === "releases") {
      void refreshRelease();
    }
  }, [activePage, refreshRelease]);

  const schemaTask = useCallback(async (task: "status" | "validate" | "plan" | "initialize" | "migrate", confirmation?: string) => {
    setSchemaBusy(task);
    try {
      const command = task === "status" ? "schema_status" : task === "validate" ? "validate_schema" : task === "plan" ? "plan_schema" : task === "initialize" ? "initialize_schema" : "migrate_schema";
      const response = await invoke<SchemaStatus | SchemaPlan>(command, confirmation === undefined ? {} : { confirmation });
      if (task === "plan") setSchemaPlan(response as SchemaPlan);
      else setSchemaStatus(response as SchemaStatus);
      if (task === "initialize" || task === "migrate") {
        setSchemaConfirmation("");
        setSchemaPlan(null);
      }
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSchemaBusy(null);
    }
  }, []);

  useEffect(() => {
    if (activePage === "schema") void schemaTask("status");
  }, [activePage, schemaTask]);

  const loadSnapshotStatus = useCallback(async () => {
    const [response, retentionSchedule, nightlySchedule] = await Promise.all([
      invoke<SnapshotStatus>("maintenance_snapshot_status"),
      invoke<RetentionScheduleStatus>("maintenance_snapshot_retention_schedule_status"),
      invoke<NightlyScheduleStatus>("maintenance_snapshot_nightly_schedule_status"),
    ]);
    setSnapshotStatus(response);
    setRetentionScheduleStatus(retentionSchedule);
    setNightlyScheduleStatus(nightlySchedule);
    return response;
  }, []);

  const snapshotTask = async (action: "schedule-enable" | "schedule-disable" | "nightly-schedule-enable" | "nightly-schedule-disable") => {
    setSnapshotBusy(action);
    try {
      if (action === "schedule-enable") {
        const response = await invoke<RetentionScheduleStatus>("maintenance_snapshot_retention_schedule_enable");
        setRetentionScheduleStatus(response);
      } else if (action === "schedule-disable") {
        const response = await invoke<RetentionScheduleStatus>("maintenance_snapshot_retention_schedule_disable");
        setRetentionScheduleStatus(response);
      } else if (action === "nightly-schedule-enable") {
        const response = await invoke<NightlyScheduleStatus>("maintenance_snapshot_nightly_schedule_enable");
        setNightlyScheduleStatus(response);
      } else if (action === "nightly-schedule-disable") {
        const response = await invoke<NightlyScheduleStatus>("maintenance_snapshot_nightly_schedule_disable");
        setNightlyScheduleStatus(response);
      }
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSnapshotBusy(null);
    }
  };

  useEffect(() => {
    if (activePage !== "snapshots") return;
    void loadSnapshotStatus().catch((reason) => setError(String(reason)));
  }, [activePage, loadSnapshotStatus]);

  const loadBackupStatus = useCallback(async () => {
    const response = await invoke<BackupStatus>("maintenance_backup_status");
    setBackupStatus(response);
    return response;
  }, []);

  const backupTask = async () => {
    setBackupBusy("verify");
    try {
      await invoke("maintenance_backup_verify");
      await loadBackupStatus();
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBackupBusy(null);
    }
  };

  const restoreActiveSnapshot = async (confirmation: string) => {
    setBackupBusy("restore");
    try {
      await invoke("maintenance_backup_restore_active", { confirmation });
      await loadBackupStatus();
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBackupBusy(null);
    }
  };

  useEffect(() => {
    if (activePage !== "backup") return;
    void loadBackupStatus().catch((reason) => setError(String(reason)));
  }, [activePage, loadBackupStatus]);

  const loadConflictStatus = useCallback(async () => {
    const response = await invoke<ConflictStatus>("maintenance_conflict_list");
    setConflictStatus(response);
    return response;
  }, []);

  const exportConflicts = async () => {
    setConflictBusy("export");
    try {
      const response = await invoke<ConflictStatus>("maintenance_conflict_export");
      setConflictStatus(response);
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setConflictBusy(null);
    }
  };

  useEffect(() => {
    if (activePage !== "conflicts") return;
    setConflictBusy("list");
    void loadConflictStatus().catch((reason) => setError(String(reason))).finally(() => setConflictBusy(null));
  }, [activePage, loadConflictStatus]);

  const loadLogStatus = useCallback(async () => {
    const response = await invoke<LogStatus>("maintenance_log_list", { selectedDate: logDate });
    setLogStatus(response);
    return response;
  }, [logDate]);

  useEffect(() => {
    if (activePage !== "logs") return;
    setLogBusy(true);
    void loadLogStatus().catch((reason) => setError(String(reason))).finally(() => setLogBusy(false));
  }, [activePage, loadLogStatus]);

  const loadActivityStatus = useCallback(async () => {
    const response = await invoke<ActivityStatus>("maintenance_activity_list", { selectedDate: activityDate });
    setActivityStatus(response);
    return response;
  }, [activityDate]);

  useEffect(() => {
    if (activePage !== "activity") return;
    void loadActivityStatus().catch((reason) => setError(String(reason)));
  }, [activePage, loadActivityStatus]);

  const loadSettingsStatus = useCallback(async () => {
    const response = await invoke<SettingsStatus>("maintenance_settings_status");
    setSettingsStatus(response);
    setSettingsNetworkRoot((current) => current || response.network_root);
    return response;
  }, []);

  const saveNetworkRoot = async () => {
    setSettingsBusy(true);
    try {
      await invoke("maintenance_update_network_root", { networkRoot: settingsNetworkRoot.trim() });
      await loadSettingsStatus();
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSettingsBusy(false);
    }
  };

  useEffect(() => {
    if (activePage !== "settings") return;
    void loadSettingsStatus().catch((reason) => setError(String(reason)));
  }, [activePage, loadSettingsStatus]);

  const execute = async (action: SourceDataAction) => {
    setBusy(action);
    try {
      const command = action === "service-start"
        ? "start_scheduler"
        : action === "service-stop"
          ? "stop_scheduler"
          : action === "schedule-enable"
            ? "enable_source_scheduler_schedule"
            : "disable_source_scheduler_schedule";
      await invoke(command);
      await new Promise((resolve) => window.setTimeout(resolve, action === "service-start" ? 900 : 350));
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  const openLogs = async () => {
    try {
      await invoke("open_path", { path: status?.logDirectory ?? "" });
    } catch (reason) {
      setError(String(reason));
    }
  };

  const openPath = async (path: string) => {
    try {
      await invoke("open_path", { path });
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  };

  const openFileLocation = async (path: string) => {
    try {
      await invoke("open_file_location", { path });
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  };

  const validateRepository = async () => {
    setRepositoryBusy("validate");
    try {
      const response = await invoke<RepositoryStatus>("validate_repository");
      setRepositoryStatus(response);
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRepositoryBusy(null);
    }
  };

  const bootstrapRepository = async (networkRoot: string) => {
    if (!networkRoot) {
      return;
    }
    setRepositoryBusy("bootstrap");
    try {
      const response = await invoke<RepositoryStatus>("bootstrap_repository", {
        networkRoot,
      });
      setRepositoryStatus(response);
      setRepositoryNetworkRoot(response.network_root);
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRepositoryBusy(null);
    }
  };

  const publishRelease = async () => {
    const version = releaseVersion.trim() || undefined;
    const label = releaseMode === "system-db" ? "system database only" : releaseMode === "portal-exe" ? "Portal executable only" : "the full portable folder";
    if (!window.confirm(`Publish ${label} as release ${version ?? releaseStatus?.packageVersion ?? ""}?`)) {
      return;
    }
    setReleaseSuccess("");
    setReleaseProgress("Preparing the release.");
    setReleaseBusy(true);
    try {
      const response = await invoke<PortalReleaseStatus>("publish_portal_release", {
        updateMode: releaseMode,
        releaseVersion: version,
      });
      setReleaseStatus(response);
      setReleaseVersion(response.currentReleaseVersion ?? response.packageVersion);
      setReleaseSuccess(`${response.currentUpdateMode ?? releaseMode} release ${response.currentReleaseVersion ?? response.packageVersion} is available at ${response.releaseRoot}.`);
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setReleaseBusy(false);
    }
  };

  const activeLabel = navigation.find((item) => item.id === activePage)?.label ?? "Overview";
  const refreshActivePage = () => {
    if (activePage === "repository") {
      void refreshRepository();
      return;
    }
    if (activePage === "releases") {
      void refreshRelease();
      return;
    }
    if (activePage === "schema") {
      void schemaTask("status");
      return;
    }
    if (activePage === "snapshots") {
      void loadSnapshotStatus().catch((reason) => setError(String(reason)));
      return;
    }
    if (activePage === "backup") {
      void loadBackupStatus().catch((reason) => setError(String(reason)));
      return;
    }
    if (activePage === "conflicts") {
      setConflictBusy("list");
      void loadConflictStatus().catch((reason) => setError(String(reason))).finally(() => setConflictBusy(null));
      return;
    }
    if (activePage === "logs") {
      setLogBusy(true);
      void loadLogStatus().catch((reason) => setError(String(reason))).finally(() => setLogBusy(false));
      return;
    }
    if (activePage === "activity") {
      void loadActivityStatus().catch((reason) => setError(String(reason)));
      return;
    }
    if (activePage === "settings") {
      void loadSettingsStatus().catch((reason) => setError(String(reason)));
      return;
    }
    if (activePage === "source-data" || activePage === "overview") {
      void refresh();
    }
  };
  const canRefresh = true;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <p className="eyebrow">PORTAL WORKSTATION</p>
          <strong>Manager</strong>
        </div>
        <nav aria-label="Workstation functions">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={item.id === activePage ? "navigation-link active" : "navigation-link"}
                key={item.id}
                onClick={() => setActivePage(item.id)}
              >
                <Icon size={18} />
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <span>Standalone desktop app</span>
          <span>Python task coordinator</span>
        </div>
      </aside>

      <section className="workspace-shell">
        <header className="app-header">
          <div className="page-heading">
            <p className="eyebrow">PORTAL WORKSTATION</p>
            <h1>{activeLabel}</h1>
            <p>{pageDescriptions[activePage]}</p>
          </div>
          {canRefresh && (
            <button className="quiet-button" onClick={refreshActivePage} title="Refresh status">
              <RefreshCw size={18} />
              Refresh
            </button>
          )}
        </header>

        {error && (
          <section className="notice error">
            <CircleAlert size={18} />
            <span>{error}</span>
          </section>
        )}

        {activePage === "overview" && <Overview status={status} navigate={setActivePage} />}
        {activePage === "source-data" && (
          <SourceDataWorkspace
            busy={busy}
            execute={(action) => void execute(action)}
            openLogs={() => void openLogs()}
            selectedDate={selectedDate}
            setSelectedDate={setSelectedDate}
            status={status}
          />
        )}
        {activePage === "repository" && (
          <RepositoryWorkspace
            bootstrap={(networkRoot) => void bootstrapRepository(networkRoot)}
            busy={repositoryBusy}
            networkRoot={repositoryNetworkRoot}
            refresh={() => void refreshRepository()}
            setNetworkRoot={setRepositoryNetworkRoot}
            status={repositoryStatus}
            validate={() => void validateRepository()}
          />
        )}
        {activePage === "releases" && (
          <ReleaseWorkspace
            busy={releaseBusy}
            progress={releaseProgress}
            releaseVersion={releaseVersion}
            setReleaseVersion={setReleaseVersion}
            setUpdateMode={setReleaseMode}
            status={releaseStatus}
            success={releaseSuccess}
            updateMode={releaseMode}
            publish={() => void publishRelease()}
          />
        )}
        {activePage === "schema" && (
          <SchemaWorkspace
            busy={schemaBusy}
            confirmation={schemaConfirmation}
            execute={(action) => void schemaTask(action, schemaConfirmation)}
            loadPlan={() => void schemaTask("plan")}
            plan={schemaPlan}
            setConfirmation={setSchemaConfirmation}
            status={schemaStatus}
            validate={() => void schemaTask("validate")}
          />
        )}
        {activePage === "snapshots" && <SnapshotWorkspace status={snapshotStatus} schedule={retentionScheduleStatus} nightlySchedule={nightlyScheduleStatus} busy={snapshotBusy} execute={(action) => void snapshotTask(action)} openLocation={(path) => void openFileLocation(path)} />}
        {activePage === "backup" && <BackupWorkspace status={backupStatus} busy={backupBusy} execute={() => void backupTask()} restore={(confirmation) => void restoreActiveSnapshot(confirmation)} openPath={(path) => void openPath(path)} />}
        {activePage === "conflicts" && <ConflictWorkspace status={conflictStatus} busy={conflictBusy} exportConflicts={() => void exportConflicts()} openPath={(path) => void openPath(path)} />}
        {activePage === "activity" && <ActivityWorkspace status={activityStatus} selectedDate={activityDate} setSelectedDate={setActivityDate} openPath={(path) => void openPath(path)} openFileLocation={(path) => void openFileLocation(path)} />}
        {activePage === "logs" && <LogsWorkspace status={logStatus} busy={logBusy} selectedDate={logDate} setSelectedDate={setLogDate} openPath={(path) => void openPath(path)} />}
        {activePage === "settings" && <SettingsWorkspace status={settingsStatus} busy={settingsBusy} networkRoot={settingsNetworkRoot} setNetworkRoot={setSettingsNetworkRoot} save={() => void saveNetworkRoot()} />}
      </section>
    </main>
  );
}
