import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  clearManagementToken,
  saveManagementToken,
  saveManagementUser,
  type PortalUser,
} from "../../ui/src/management/api";
import {
  ArchiveRestore,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  Database,
  DatabaseBackup,
  FileCog,
  FolderOpen,
  GitBranch,
  HardDriveDownload,
  History,
  LayoutDashboard,
  ListChecks,
  Map as MapIcon,
  PackageCheck,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  ScrollText,
  Save,
  Settings,
  ShieldAlert,
  Square,
  Trash2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import ManagerWorkspaceHub from "./ManagerWorkspaceHub";
import PortalAdministrationPage from "./management/PortalAdministrationPage";
import { appConfirm } from "./messageDialogService";
import { formatDateOnly, formatDateTime, formatLocalClock, formatScheduleLabel, todayIsoDate } from "../../ui/src/lib/dateTime";

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
  scheduledTaskMinute: number;
  intervalMinutes: number;
  scheduledTaskState: string;
  statusText: string;
  nextRunText: string;
  publishedDatabase: string;
  latestResult: string;
  logDirectory: string;
  syncSettingsFile: string;
  runs: SyncRun[];
};

type SourceDataAction = "service-start" | "service-stop" | "schedule-enable" | "schedule-disable" | "run" | "check" | "interval-save";

type RepositoryStatus = {
  network_root: string;
  protocol_root: string;
  system_database: string;
  shared_available: boolean;
  initialized: boolean;
  can_initialize: boolean;
  membership_count: number;
  membership_release_id: string;
  membership_generation: number;
  snapshot_id: string;
  snapshot_epoch_id: string;
  snapshot_path: string;
  snapshot_size_bytes: number;
  active_writer_count: number;
  active_writers: Array<{
    actor_id: string;
    user_id: string;
    employee_number: string;
    generation: number;
    highest_published_seq: number;
    state: string;
    registration_path: string;
  }>;
  locks: {
    epoch_transition: { path: string; exists: boolean; available: boolean; state: string; message?: string };
    actor_publication: { path: string; exists: boolean; state: string };
    save_mutex_count: number;
    expected_save_mutex_count: number;
  };
  issues: Array<{ severity: string; code: string; message: string; path?: string }>;
  validation_performed: boolean;
  valid?: boolean;
  message?: string;
  configured_files?: string[];
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

const SQLITE_TYPE_GROUPS = [
  { label: "Text", types: ["TEXT", "CHAR", "VARCHAR", "NCHAR", "NVARCHAR", "CLOB"] },
  { label: "Integer", types: ["INTEGER", "INT", "TINYINT", "SMALLINT", "MEDIUMINT", "BIGINT"] },
  { label: "Boolean", types: ["BOOLEAN"] },
  { label: "Numeric", types: ["REAL", "FLOAT", "DOUBLE", "DOUBLE PRECISION", "NUMERIC", "DECIMAL"] },
  { label: "Date and time", types: ["DATE", "TIME", "DATETIME", "TIMESTAMP"] },
  { label: "Binary", types: ["BLOB"] },
] as const;

type SQLiteDeclaredType = (typeof SQLITE_TYPE_GROUPS)[number]["types"][number];

const SQLITE_NUMERIC_TYPES = new Set<SQLiteDeclaredType>([
  "INTEGER", "INT", "TINYINT", "SMALLINT", "MEDIUMINT", "BIGINT",
  "REAL", "FLOAT", "DOUBLE", "DOUBLE PRECISION", "NUMERIC", "DECIMAL",
]);

type SchemaDraftOperation =
  | {
      kind: "add_table";
      table_id: string;
      physical_table: string;
      dependency_order: number;
    }
  | {
      kind: "rename_table";
      table_id: string;
      physical_table: string;
    }
  | {
      kind: "add_column";
      table_id: string;
      column: string;
      sqlite_type: SQLiteDeclaredType;
      nullable: boolean;
      default: string | number | boolean | null;
    }
  | {
      kind: "rename_column";
      table_id: string;
      field_id: string;
      column: string;
    }
  | {
      kind: "create_index";
      table_id: string;
      index: string;
      columns: string[];
      unique: boolean;
    }
  | {
      kind: "drop_index";
      table_id: string;
      index: string;
    };

type SchemaCatalogField = {
  field_id: string;
  physical_column: string;
  logical_type: string;
  sqlite_type: string;
  nullable: boolean;
  default_json?: string | null;
  system_managed: boolean;
  sync_role: string;
  ordinal: number;
  draft?: boolean;
  renamed_from?: string;
  removed?: boolean;
};

type SchemaCatalogIndex = {
  index_id: string;
  physical_name: string;
  unique_flag: boolean;
  columns: string[];
  draft?: boolean;
  removed?: boolean;
};

type SchemaCatalogTable = {
  table_id: string;
  physical_table: string;
  dependency_order: number;
  fields: SchemaCatalogField[];
  indexes: SchemaCatalogIndex[];
  draft?: boolean;
  renamed_from?: string;
};

type SchemaCatalog = {
  release_id: string;
  schema_version: number;
  catalog_hash: string;
  base_release_id: string;
  draft_path: string;
  dirty: boolean;
  test_passed: boolean;
  last_test?: {
    passed: boolean;
    source_snapshot_id: string;
    migration_count: number;
    affected_tables: string[];
    row_counts: Record<string, number>;
    duration_seconds: number;
  } | null;
  operations: SchemaDraftOperation[];
  tables: SchemaCatalogTable[];
  table_count: number;
  field_count: number;
  index_count: number;
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
  desktopSystemDb: string;
  managerSystemDbWritable: boolean;
  desktopSystemDbReadOnly: boolean;
  desktopSystemDbCurrent: boolean;
};

type PageId =
  | "overview"
  | "source-data"
  | "source-backup"
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

type SourceBackupTaskSchedule = {
  task_name: string;
  registered: boolean;
  managed: boolean;
  state: string;
  next_run: string;
  last_run: string;
  last_result: string;
};

type SourceBackupRun = {
  run_id: string;
  action: string;
  status: string;
  details: string;
  started_at: string;
  finished_at: string;
  duration_seconds?: number;
  log_path: string;
};

type SourceBackupArchive = {
  name: string;
  path: string;
  size_bytes: number;
  modified_at: string;
};

type MapTilesProgress = {
  status: string;
  engine?: "tippecanoe" | "gdal" | "python";
  phase?: string;
  phasePercent?: number | null;
  message?: string;
  startedAt: string;
  updatedAt: string;
  output: string;
  workerCount: number;
  threadsPerWorker: number;
  tippecanoeThreads?: string;
  tippecanoeGroupWorkers?: number;
  gdalThreads?: string;
  totalLayers: number;
  completedLayers: number;
  completedLayerIds: string[];
  activeLayers: Array<{ index: number; id: string }>;
  error?: string;
};

type SourceBackupStatus = {
  available: boolean;
  missing_files: string[];
  map_tiles_available: boolean;
  map_tiles_missing_files: string[];
  map_tiles_directory?: string;
  map_tiles_builder?: string;
  map_tiles_settings_file?: string;
  map_tiles_progress_file?: string;
  map_tiles_progress?: MapTilesProgress;
  map_tiles_tileset_count?: number;
  map_tiles_output_count?: number;
  scripts_directory: string;
  manager_settings_file: string;
  backup_settings_file?: string;
  clone_settings_file?: string;
  state_directory: string;
  log_directory: string;
  source_directory?: string;
  backup_directory?: string;
  output_root?: string;
  retention_days?: number;
  database_count?: number;
  refresh_ready?: boolean;
  credential_issues?: string[];
  directory_source_count?: number;
  notification_recipient_count?: number;
  create_filegdb?: boolean;
  spatial_warehouse_output_path?: string;
  spatial_warehouse_layer_count?: number;
  archive_count?: number;
  daily_schedule: string;
  weekly_backup_schedule: string;
  heartbeat_schedule_label: string;
  workflow_time: string;
  backup_weekday: string;
  heartbeat_day: string;
  heartbeat_time: string;
  workflow_schedule: SourceBackupTaskSchedule;
  heartbeat_schedule: SourceBackupTaskSchedule;
  state: Partial<SourceBackupRun> & { pid?: number };
  runs: SourceBackupRun[];
  archives: SourceBackupArchive[];
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

type ManagerStartupSession = {
  token?: string;
  token_type?: string;
  user: PortalUser;
};

type ManagerAuthorization = "checking" | "authorized" | "denied";
type ManagerWorkspace = "hub" | "maintenance" | "portal-admin";

const today = todayIsoDate();

const navigation: NavigationItem[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "source-backup", label: "Mirrors & Backups", icon: DatabaseBackup },
  { id: "source-data", label: "Serving Data", icon: Database },
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
  "source-backup": "Rebuild source mirrors, retain archives, and publish map tiles.",
  "source-data": "Rebuild and publish Portal-ready serving tables.",
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
  return formatDateOnly(value);
}

function formatTimestamp(value?: string) {
  return formatDateTime(value);
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

function formatDuration(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "-";
  if (value < 60) return `${value < 10 ? value.toFixed(1) : Math.round(value)} sec`;
  const totalSeconds = Math.round(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours} hr ${minutes} min`;
  return `${minutes} min ${seconds} sec`;
}

function fileName(path?: string) {
  if (!path) return "-";
  const normalized = path.replaceAll("\\", "/");
  return normalized.split("/").filter(Boolean).at(-1) || path;
}

function friendlyBackupName(name: string) {
  const snapshotMatch = name.match(/^backup-\d{8}-([0-9a-f]{8})[0-9a-f-]*-[0-9a-f]{64}\.db$/i);
  return snapshotMatch ? `Snapshot ${snapshotMatch[1]}` : name.replace(/\.[^.]+$/, "");
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
  catalog,
  plan,
  busy,
  confirmation,
  setConfirmation,
  register,
  testDraft,
  saveDraft,
  discardDraft,
  validate,
  loadPlan,
  execute,
}: {
  status: SchemaStatus | null;
  catalog: SchemaCatalog | null;
  plan: SchemaPlan | null;
  busy: string | null;
  confirmation: string;
  setConfirmation: (value: string) => void;
  register: () => void;
  testDraft: () => void;
  saveDraft: (operations: SchemaDraftOperation[]) => Promise<void>;
  discardDraft: () => Promise<void>;
  validate: () => void;
  loadPlan: () => void;
  execute: (action: "initialize" | "migrate") => void;
}) {
  const [tableSearch, setTableSearch] = useState("");
  const [selectedTableId, setSelectedTableId] = useState("");
  const [detailTab, setDetailTab] = useState<"fields" | "indexes">("fields");
  const [editor, setEditor] = useState<"table" | "rename-table" | "field" | "rename-field" | "index" | null>(null);
  const [editingOperation, setEditingOperation] = useState<number | null>(null);
  const [tableId, setTableId] = useState("");
  const [tablePhysicalName, setTablePhysicalName] = useState("");
  const [tableDependencyOrder, setTableDependencyOrder] = useState("");
  const [fieldName, setFieldName] = useState("");
  const [renamingFieldId, setRenamingFieldId] = useState("");
  const [fieldType, setFieldType] = useState<SQLiteDeclaredType>("TEXT");
  const [fieldNullable, setFieldNullable] = useState(true);
  const [fieldDefault, setFieldDefault] = useState("");
  const [indexName, setIndexName] = useState("");
  const [indexColumns, setIndexColumns] = useState("");
  const [indexUnique, setIndexUnique] = useState(false);
  const requiresInitialization = status?.state === "unmanaged" || !status?.installed_release_id;
  const isHealthy = status?.state === "healthy";
  const migrations = plan?.migrations ?? [];
  const confirmationMatches = confirmation.trim() === status?.active_snapshot_id;
  const stateLabel = status?.state ? status.state.replaceAll("_", " ").toUpperCase() : "CHECKING";
  const visibleTables = (catalog?.tables ?? []).filter((table) => {
    const search = tableSearch.trim().toLowerCase();
    return !search || table.physical_table.toLowerCase().includes(search) || table.table_id.toLowerCase().includes(search);
  });
  const selectedTable = catalog?.tables.find((table) => table.table_id === selectedTableId) ?? visibleTables[0] ?? null;
  useEffect(() => {
    if (selectedTable && selectedTable.table_id !== selectedTableId) setSelectedTableId(selectedTable.table_id);
  }, [selectedTable, selectedTableId]);

  function resetEditor() {
    setEditor(null);
    setEditingOperation(null);
    setTableId("");
    setTablePhysicalName("");
    setTableDependencyOrder("");
    setFieldName("");
    setRenamingFieldId("");
    setFieldType("TEXT");
    setFieldNullable(true);
    setFieldDefault("");
    setIndexName("");
    setIndexColumns("");
    setIndexUnique(false);
  }

  function startAddTable() {
    resetEditor();
    const nextOrder = Math.max(0, ...(catalog?.tables ?? []).map((table) => table.dependency_order)) + 10;
    setTableId(`tbl_${crypto.randomUUID().replaceAll("-", "")}`);
    setTableDependencyOrder(String(nextOrder));
    setEditor("table");
  }

  async function saveTable() {
    if (!catalog || !tableId.trim() || !tablePhysicalName.trim()) return;
    const dependencyOrder = Number(tableDependencyOrder);
    if (!Number.isInteger(dependencyOrder) || dependencyOrder < 1) return;
    const operation: SchemaDraftOperation = {
      kind: "add_table",
      table_id: tableId.trim(),
      physical_table: tablePhysicalName.trim().toUpperCase(),
      dependency_order: dependencyOrder,
    };
    await saveDraft([...catalog.operations, operation]);
    setSelectedTableId(operation.table_id);
    resetEditor();
  }

  function startRenameTable() {
    if (!selectedTable) return;
    resetEditor();
    setTablePhysicalName(selectedTable.physical_table);
    setEditor("rename-table");
  }

  async function saveTableRename() {
    if (!catalog || !selectedTable || !tablePhysicalName.trim()) return;
    const operation: SchemaDraftOperation = {
      kind: "rename_table",
      table_id: selectedTable.table_id,
      physical_table: tablePhysicalName.trim().toUpperCase(),
    };
    await saveDraft([...catalog.operations, operation]);
    resetEditor();
  }

  async function saveField() {
    if (!catalog || !selectedTable || !fieldName.trim()) return;
    if (editor === "rename-field") {
      const operation: SchemaDraftOperation = {
        kind: "rename_column",
        table_id: selectedTable.table_id,
        field_id: renamingFieldId,
        column: fieldName.trim(),
      };
      await saveDraft([...catalog.operations, operation]);
      resetEditor();
      return;
    }
    let defaultValue: string | number | boolean | null = fieldDefault.trim() || null;
    if (defaultValue !== null && SQLITE_NUMERIC_TYPES.has(fieldType)) {
      const numericValue = Number(defaultValue);
      if (!Number.isFinite(numericValue)) return;
      defaultValue = numericValue;
    }
    const operation: SchemaDraftOperation = {
      kind: "add_column",
      table_id: selectedTable.table_id,
      column: fieldName.trim(),
      sqlite_type: fieldType,
      nullable: fieldNullable,
      default: defaultValue,
    };
    const operations = [...catalog.operations];
    if (editingOperation === null) operations.push(operation);
    else operations[editingOperation] = operation;
    await saveDraft(operations);
    resetEditor();
  }

  async function saveIndex() {
    if (!catalog || !selectedTable || !indexName.trim()) return;
    const columns = indexColumns.split(",").map((column) => column.trim()).filter(Boolean);
    if (!columns.length) return;
    const operation: SchemaDraftOperation = {
      kind: "create_index",
      table_id: selectedTable.table_id,
      index: indexName.trim(),
      columns,
      unique: indexUnique,
    };
    const operations = [...catalog.operations];
    if (editingOperation === null) operations.push(operation);
    else operations[editingOperation] = operation;
    await saveDraft(operations);
    resetEditor();
  }

  function editDraftField(field: SchemaCatalogField) {
    if (!catalog || !selectedTable) return;
    const operationIndex = catalog.operations.findIndex(
      (operation) => operation.kind === "add_column" && operation.table_id === selectedTable.table_id && operation.column === field.physical_column,
    );
    const operation = catalog.operations[operationIndex];
    if (operationIndex < 0 || operation.kind !== "add_column") return;
    setDetailTab("fields");
    setEditor("field");
    setEditingOperation(operationIndex);
    setFieldName(operation.column);
    setFieldType(operation.sqlite_type);
    setFieldNullable(operation.nullable);
    setFieldDefault(operation.default === null ? "" : String(operation.default));
  }

  function startRenameField(field: SchemaCatalogField) {
    resetEditor();
    setDetailTab("fields");
    setEditor("rename-field");
    setRenamingFieldId(field.field_id);
    setFieldName(field.physical_column);
  }

  function editDraftIndex(index: SchemaCatalogIndex) {
    if (!catalog || !selectedTable) return;
    const operationIndex = catalog.operations.findIndex(
      (operation) => operation.kind === "create_index" && operation.table_id === selectedTable.table_id && operation.index === index.physical_name,
    );
    const operation = catalog.operations[operationIndex];
    if (operationIndex < 0 || operation.kind !== "create_index") return;
    setDetailTab("indexes");
    setEditor("index");
    setEditingOperation(operationIndex);
    setIndexName(operation.index);
    setIndexColumns(operation.columns.join(", "));
    setIndexUnique(operation.unique);
  }

  async function removeOperation(operationIndex: number) {
    if (!catalog || operationIndex < 0) return;
    const operations = catalog.operations.filter((_, index) => index !== operationIndex);
    await saveDraft(operations);
    resetEditor();
  }

  async function removeDraftTable() {
    if (!catalog || !selectedTable) return;
    const operations = catalog.operations.filter((operation) => operation.table_id !== selectedTable.table_id);
    await saveDraft(operations);
    setSelectedTableId("");
    resetEditor();
  }

  async function dropIndex(index: SchemaCatalogIndex) {
    if (!catalog || !selectedTable) return;
    if (!(await appConfirm(
      `Remove index ${index.physical_name} in the next schema release? No table data will be deleted.`,
      { title: "Remove schema index", kind: "warning", confirmLabel: "Remove index" },
    ))) return;
    await saveDraft([...catalog.operations, {
      kind: "drop_index",
      table_id: selectedTable.table_id,
      index: index.physical_name,
    }]);
    resetEditor();
  }

  function fieldOperationIndex(field: SchemaCatalogField) {
    if (!catalog || !selectedTable) return -1;
    return catalog.operations.findIndex((operation) => (
      operation.table_id === selectedTable.table_id && (
        (operation.kind === "add_column" && operation.column === field.physical_column) ||
        (operation.kind === "rename_column" && operation.field_id === field.field_id)
      )
    ));
  }

  function indexOperationIndex(index: SchemaCatalogIndex) {
    if (!catalog || !selectedTable) return -1;
    return catalog.operations.findIndex((operation) => (
      operation.table_id === selectedTable.table_id &&
      (operation.kind === "create_index" || operation.kind === "drop_index") &&
      operation.index === index.physical_name
    ));
  }

  function tableRenameOperationIndex() {
    if (!catalog || !selectedTable) return -1;
    return catalog.operations.findIndex((operation) => (
      operation.kind === "rename_table" && operation.table_id === selectedTable.table_id
    ));
  }

  return (
    <section className="schema-workspace">
      <div className="module-actions">
        <div>
          <p className="eyebrow">STORMWATER.DB SCHEMA</p>
          <strong>{catalog?.dirty ? `${catalog.operations.length} draft change${catalog.operations.length === 1 ? "" : "s"}` : "No unpublished draft changes"}</strong>
        </div>
        <div className="actions">
          <button className="quiet-button" disabled={busy !== null} onClick={validate}>
            <CheckCircle2 size={17} />
            {busy === "validate" ? "Validating" : "Validate database"}
          </button>
          <button className="quiet-button" disabled={busy !== null || !catalog?.dirty} onClick={testDraft}>
            <Wrench size={17} />
            {busy === "test" ? "Testing copy" : "Test draft"}
          </button>
          <button className="quiet-button" disabled={busy !== null || !catalog?.dirty || !catalog?.test_passed} onClick={register} title="Register the tested draft as the next schema release.">
            <Database size={17} />
            {busy === "register" ? "Registering" : "Register draft release"}
          </button>
          <button className="primary-button" disabled={busy !== null} onClick={loadPlan}>
            <ListChecks size={17} />
            {busy === "plan" ? "Planning" : "Review publish plan"}
          </button>
        </div>
      </div>

      <section className={isHealthy ? "status running compact-status" : "status stopped compact-status"}>
        <div>
          <p className="eyebrow">SCHEMA STATUS</p>
          <h2>{stateLabel}</h2>
          <p>{requiresInitialization
            ? "Review the catalog, register the initial release, then publish its baseline."
            : "Create typed structural drafts below. Every draft must pass a production-shaped-copy test before registration and publication."}</p>
        </div>
      </section>

      <section className="metrics schema-metrics" aria-label="Shared schema status">
        <div><span>TABLES</span><strong>{catalog?.table_count ?? "-"}</strong></div>
        <div><span>FIELDS</span><strong>{catalog?.field_count ?? "-"}</strong></div>
        <div><span>INDEXES</span><strong>{catalog?.index_count ?? "-"}</strong></div>
        <div><span>PUBLISHED RELEASE</span><strong>{status?.installed_release_id || "Unmanaged"}</strong></div>
      </section>

      {catalog?.dirty ? (
        <section className={catalog.test_passed ? "schema-test-result passed" : "schema-test-result pending"}>
          {catalog.test_passed ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}
          <div>
            <strong>{catalog.test_passed ? "Draft test passed on a production-shaped copy" : "Draft has not been tested"}</strong>
            <p>{catalog.test_passed && catalog.last_test
              ? `${catalog.last_test.migration_count} migration · ${catalog.last_test.affected_tables.length} affected table${catalog.last_test.affected_tables.length === 1 ? "" : "s"} · ${catalog.last_test.duration_seconds.toFixed(2)} sec`
              : "Test applies the generated migration to a temporary copy of the active shared snapshot. The live snapshot is not changed."}</p>
          </div>
        </section>
      ) : null}

      {editor === "table" ? (
        <section className="schema-table-editor" aria-label="Add table draft">
          <div>
            <p className="eyebrow">ADD ATTRIBUTE TABLE</p>
            <strong>Define the physical table structure.</strong>
            <small>The application generates and maintains an opaque stable identity automatically.</small>
          </div>
          <label>Physical table<input value={tablePhysicalName} onChange={(event) => setTablePhysicalName(event.target.value.toUpperCase())} placeholder="BUSINESS_DOMAIN_ITEMS" /></label>
          <label>Dependency order<input type="number" min="1" value={tableDependencyOrder} onChange={(event) => setTableDependencyOrder(event.target.value)} /></label>
          <div className="actions"><button className="quiet-button" onClick={resetEditor}>Cancel</button><button className="primary-button" disabled={!tableId.trim() || !tablePhysicalName.trim() || !tableDependencyOrder.trim()} onClick={() => void saveTable()}>Add table to draft</button></div>
        </section>
      ) : null}

      <section className="schema-catalog" aria-label="stormwater.db schema catalog">
        <aside className="schema-table-list">
          <div className="schema-table-toolbar">
            <label className="schema-table-search"><Search size={16} /><input value={tableSearch} onChange={(event) => setTableSearch(event.target.value)} placeholder="Find a table" /></label>
            <button className="quiet-button" disabled={busy !== null} onClick={startAddTable}><Plus size={15} /> Add table</button>
          </div>
          <div className="schema-table-list-scroll">
            {visibleTables.map((table) => (
              <button className={selectedTable?.table_id === table.table_id ? "active" : ""} key={table.table_id} onClick={() => { setSelectedTableId(table.table_id); resetEditor(); }}>
                <strong>{table.physical_table}</strong>
                <span>{table.fields.length} fields · {table.indexes.filter((index) => !index.removed).length} indexes{table.draft ? " · DRAFT" : ""}</span>
              </button>
            ))}
          </div>
        </aside>

        <div className="schema-table-detail">
          <div className="schema-table-detail-header">
            <div>
              <p className="eyebrow">{selectedTable?.table_id ?? "SELECT A TABLE"}</p>
              <h2>{selectedTable?.physical_table ?? "Schema details"}</h2>
            </div>
            <div className="actions">
              {selectedTable?.renamed_from ? <button className="quiet-button" disabled={busy !== null} onClick={() => void removeOperation(tableRenameOperationIndex())}>Undo rename</button> : selectedTable?.draft ? <button className="danger-button" disabled={busy !== null} onClick={() => void removeDraftTable()}><Trash2 size={16} /> Remove draft table</button> : <button className="quiet-button" disabled={!selectedTable || busy !== null} onClick={startRenameTable}><Pencil size={16} /> Rename table</button>}
              <button className="quiet-button" disabled={!selectedTable || busy !== null} onClick={() => { resetEditor(); setDetailTab("fields"); setEditor("field"); }}><Plus size={16} /> Add field</button>
              <button className="quiet-button" disabled={!selectedTable || busy !== null} onClick={() => { resetEditor(); setDetailTab("indexes"); setEditor("index"); }}><Plus size={16} /> Add index</button>
              <button className="danger-button" disabled={!catalog?.dirty || busy !== null} onClick={() => void discardDraft()}><Trash2 size={16} /> Discard draft</button>
            </div>
          </div>

          {editor === "rename-table" && selectedTable ? (
            <div className="schema-inline-editor rename-table-editor">
              <label className="wide">New physical table name<input value={tablePhysicalName} onChange={(event) => setTablePhysicalName(event.target.value.toUpperCase())} placeholder="BUSINESS_DOMAIN_ITEMS" /></label>
              <p>The application-maintained stable identity will not change.</p>
              <div className="actions"><button className="quiet-button" onClick={resetEditor}>Cancel</button><button className="primary-button" disabled={!tablePhysicalName.trim() || tablePhysicalName === selectedTable.physical_table} onClick={() => void saveTableRename()}>Add rename to draft</button></div>
            </div>
          ) : null}

          <div className="schema-detail-tabs">
            <button className={detailTab === "fields" ? "active" : ""} onClick={() => setDetailTab("fields")}>Fields ({selectedTable?.fields.length ?? 0})</button>
            <button className={detailTab === "indexes" ? "active" : ""} onClick={() => setDetailTab("indexes")}>Indexes ({selectedTable?.indexes.length ?? 0})</button>
          </div>

          {(editor === "field" || editor === "rename-field") && selectedTable ? (
            <div className="schema-inline-editor">
              <label>Field name<input value={fieldName} onChange={(event) => setFieldName(event.target.value)} placeholder="new_field_name" /></label>
              {editor === "field" ? <><label>SQLite declared type<select value={fieldType} onChange={(event) => setFieldType(event.target.value as SQLiteDeclaredType)}>{SQLITE_TYPE_GROUPS.map((group) => <optgroup key={group.label} label={group.label}>{group.types.map((sqliteType) => <option key={sqliteType} value={sqliteType}>{sqliteType}</option>)}</optgroup>)}</select></label><label>Default value<input value={fieldDefault} onChange={(event) => setFieldDefault(event.target.value)} placeholder="Optional" /></label><label className="schema-check"><input type="checkbox" checked={fieldNullable} onChange={(event) => setFieldNullable(event.target.checked)} /> Allow null</label></> : <p className="schema-editor-explanation">Stable field ID <strong>{renamingFieldId}</strong> will be preserved.</p>}
              <div className="actions"><button className="quiet-button" onClick={resetEditor}>Cancel</button><button className="primary-button" disabled={!fieldName.trim() || (editor === "field" && !fieldNullable && !fieldDefault.trim())} onClick={() => void saveField()}>{editor === "rename-field" ? "Add rename to draft" : editingOperation === null ? "Add to draft" : "Save draft field"}</button></div>
            </div>
          ) : null}

          {editor === "index" && selectedTable ? (
            <div className="schema-inline-editor index-editor">
              <label>Index name<input value={indexName} onChange={(event) => setIndexName(event.target.value)} placeholder={`IX_${selectedTable.physical_table}_name`} /></label>
              <label className="wide">Fields in order<input value={indexColumns} onChange={(event) => setIndexColumns(event.target.value)} placeholder="field_one, field_two" /></label>
              <label className="schema-check"><input type="checkbox" checked={indexUnique} onChange={(event) => setIndexUnique(event.target.checked)} /> Unique</label>
              <div className="actions"><button className="quiet-button" onClick={resetEditor}>Cancel</button><button className="primary-button" disabled={!indexName.trim() || !indexColumns.trim()} onClick={() => void saveIndex()}>{editingOperation === null ? "Add to draft" : "Save draft index"}</button></div>
            </div>
          ) : null}

          <div className="table-scroll schema-definition-table">
            {detailTab === "fields" ? (
              <table><thead><tr><th>Field</th><th>Type</th><th>Null</th><th>Default</th><th>Role</th><th>Actions</th></tr></thead><tbody>
                {(selectedTable?.fields ?? []).map((field) => {
                  const operationIndex = fieldOperationIndex(field);
                  return <tr key={field.field_id} className={field.draft ? "draft-row" : ""}>
                    <td><strong>{field.physical_column}</strong>{field.renamed_from ? <small className="schema-change-note">Renamed from {field.renamed_from}</small> : null}</td>
                    <td>{field.sqlite_type}</td><td>{field.nullable ? "Yes" : "No"}</td><td>{field.default_json ?? "-"}</td><td>{field.system_managed ? "System" : "Business"}</td>
                    <td>{field.system_managed ? "Protected" : field.renamed_from ? <button className="table-button" onClick={() => void removeOperation(operationIndex)}>Undo rename</button> : field.draft ? <div className="actions"><button className="table-button" onClick={() => editDraftField(field)}>Edit</button><button className="table-button danger" onClick={() => void removeOperation(operationIndex)}>Remove</button></div> : <button className="table-button" onClick={() => startRenameField(field)}><Pencil size={13} /> Rename</button>}</td>
                  </tr>;
                })}
              </tbody></table>
            ) : (
              <table><thead><tr><th>Index</th><th>Fields</th><th>Unique</th><th>Actions</th></tr></thead><tbody>
                {(selectedTable?.indexes ?? []).map((index) => {
                  const operationIndex = indexOperationIndex(index);
                  return <tr key={index.index_id} className={`${index.draft ? "draft-row" : ""}${index.removed ? " removed-row" : ""}`}>
                    <td><strong>{index.physical_name}</strong>{index.removed ? <small className="schema-change-note">Removal drafted</small> : null}</td><td>{index.columns.join(", ")}</td><td>{index.unique_flag ? "Yes" : "No"}</td>
                    <td>{index.removed ? <button className="table-button" onClick={() => void removeOperation(operationIndex)}>Undo removal</button> : index.draft ? <div className="actions"><button className="table-button" onClick={() => editDraftIndex(index)}>Edit</button><button className="table-button danger" onClick={() => void removeOperation(operationIndex)}>Remove</button></div> : <button className="table-button danger" onClick={() => void dropIndex(index)}><Trash2 size={13} /> Drop index</button>}</td>
                  </tr>;
                })}
              </tbody></table>
            )}
          </div>
          <p className="schema-safety-note"><ShieldAlert size={15} /> Add, rename, and index changes use the tested Alembic migration path. Field and table deletion remain blocked until the required deprecation and drain workflow is implemented.</p>
        </div>
      </section>

      <section className="schema-plan" aria-label="Schema migration plan">
        <div className="table-toolbar">
          <div>
            <p className="eyebrow">MIGRATION PLAN</p>
            <h2>{plan ? `${plan.from_release_id || "Unmanaged"} to ${plan.to_release_id || "Active release"}` : "Register the draft, then review its publish plan"}</h2>
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
          <p className="eyebrow">PUBLISH STORMWATER.DB SCHEMA</p>
          <p>Confirm the current snapshot. The Manager creates and validates a replacement shared snapshot before switching clients to it.</p>
        </div>
        <div className={`schema-snapshot-confirmation${confirmationMatches ? " confirmed" : ""}`}>
          <button
            className="quiet-button"
            disabled={!status?.active_snapshot_id || confirmationMatches || busy !== null}
            onClick={() => setConfirmation(status?.active_snapshot_id ?? "")}
          >
            <CheckCircle2 size={17} /> {confirmationMatches ? "Current snapshot confirmed" : "Confirm current snapshot"}
          </button>
          <span>{confirmationMatches ? "Ready to publish." : "Required before publishing."}</span>
        </div>
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
  configuredNetworkRoot,
  setNetworkRoot,
  browse,
  refresh,
  inspect,
  validate,
  configure,
  bootstrap,
  openPath,
}: {
  status: RepositoryStatus | null;
  busy: "refresh" | "browse" | "inspect" | "validate" | "configure" | "bootstrap" | null;
  networkRoot: string;
  configuredNetworkRoot: string;
  setNetworkRoot: (value: string) => void;
  browse: () => void;
  refresh: () => void;
  inspect: (networkRoot: string) => void;
  validate: () => void;
  configure: (networkRoot: string, confirmation: string) => void;
  bootstrap: (networkRoot: string, confirmation: string) => void;
  openPath: (path: string) => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const initialized = status?.initialized ?? false;
  const sharedAvailable = status?.shared_available ?? false;
  const selectedPath = networkRoot.trim();
  const normalizePath = (value: string) => value.trim().replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
  const selectedIsConfigured = Boolean(selectedPath) && normalizePath(selectedPath) === normalizePath(configuredNetworkRoot);
  const confirmationMatches = Boolean(selectedPath) && normalizePath(confirmation) === normalizePath(selectedPath);
  const hasErrors = Boolean(status?.issues.some((issue) => issue.severity === "error"));
  const canConfigure = initialized && !selectedIsConfigured && !hasErrors;
  const canInitialize = Boolean(status?.can_initialize) && !initialized;
  const stateLabel = status?.valid === true ? "VALIDATED" : initialized ? "INITIALIZED" : sharedAvailable ? "NOT INITIALIZED" : "UNAVAILABLE";

  function updateSelectedPath(value: string) {
    setNetworkRoot(value);
    setConfirmation("");
  }

  return (
    <section className="repository-workspace">
      <div className="module-actions">
        <div className="actions">
          <button className="quiet-button" disabled={busy !== null} onClick={refresh}>
            <RefreshCw size={17} /> Configured repository
          </button>
          <button className="primary-button" disabled={!initialized || busy !== null} onClick={validate}>
            <ShieldAlert size={17} />
            {busy === "validate" ? "Validating" : "Validate"}
          </button>
        </div>
      </div>

      <section className={initialized && !hasErrors ? "status running compact-status" : "status stopped compact-status"}>
        <div>
          <p className="eyebrow">REPOSITORY STATUS</p>
          <h2>{stateLabel}</h2>
          <p>{status?.message ?? (sharedAvailable ? "The shared location is available." : "Checking the configured shared location.")}</p>
        </div>
      </section>

      <section className="metrics repository-metrics" aria-label="Repository status">
        <div>
          <span>MEMBERS</span>
          <strong>{status?.membership_count ?? "-"}</strong>
        </div>
        <div>
          <span>ACTIVE WRITERS</span>
          <strong>{status?.active_writer_count ?? "-"}</strong>
        </div>
        <div>
          <span>MEMBERSHIP GENERATION</span>
          <strong>{status?.membership_generation || "-"}</strong>
        </div>
        <div>
          <span>SAVE MUTEXES</span>
          <strong>{status ? `${status.locks.save_mutex_count} / ${status.locks.expected_save_mutex_count}` : "-"}</strong>
        </div>
      </section>

      <section className="repository-details">
        <div><span>Configured repository</span><strong>{configuredNetworkRoot || "Not configured"}</strong></div>
        <div><span>Membership release</span><strong>{status?.membership_release_id || "-"}</strong></div>
        <div><span>Snapshot / epoch</span><strong>{status?.snapshot_id ? `${status.snapshot_id} / ${status.snapshot_epoch_id}` : "-"}</strong></div>
      </section>

      <section className="repository-location-panel">
        <div>
          <p className="eyebrow">REPOSITORY LOCATION</p>
          <h3>Inspect, select, or initialize a shared root</h3>
          <p>Selecting an existing repository does not move files. Initialization is allowed only for an empty protocol location.</p>
        </div>
        <div className="repository-location-controls">
          <label>
            <span>Shared repository path</span>
            <div>
              <input aria-label="Shared repository path" value={networkRoot} placeholder="Shared repository path" onChange={(event) => updateSelectedPath(event.target.value)} />
              <button className="quiet-button" disabled={busy !== null} onClick={browse}>
                <FolderOpen size={17} /> {busy === "browse" ? "Opening" : "Browse"}
              </button>
              <button className="quiet-button" disabled={busy !== null || !selectedPath} onClick={() => inspect(selectedPath)}>
                {busy === "inspect" ? "Inspecting" : "Inspect path"}
              </button>
              {sharedAvailable ? (
                <button className="quiet-button" disabled={busy !== null} onClick={() => openPath(selectedPath)}>
                  <FolderOpen size={17} /> Open location
                </button>
              ) : null}
            </div>
          </label>
          {(canConfigure || canInitialize) ? (
            <label>
              <span>Type the complete selected path to confirm</span>
              <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={selectedPath} />
            </label>
          ) : null}
          <div className="repository-location-actions">
            {canConfigure ? (
              <button className="primary-button" disabled={busy !== null || !confirmationMatches} onClick={() => configure(selectedPath, confirmation)}>
                <CheckCircle2 size={17} /> {busy === "configure" ? "Saving" : "Use this repository"}
              </button>
            ) : null}
            {canInitialize ? (
              <button className="danger-button" disabled={busy !== null || !confirmationMatches} onClick={() => bootstrap(selectedPath, confirmation)}>
                <Database size={17} /> {busy === "bootstrap" ? "Initializing" : "Initialize repository"}
              </button>
            ) : null}
          </div>
        </div>
      </section>

      {initialized ? (
        <section className="repository-health-grid">
          <div><span>EPOCH TRANSITION LOCK</span><strong>{status?.locks.epoch_transition.state.replaceAll("_", " ") ?? "-"}</strong><small>{status?.locks.epoch_transition.path}</small></div>
          <div><span>ACTOR PUBLICATION LOCK</span><strong>{status?.locks.actor_publication.state ?? "-"}</strong><small>{status?.locks.actor_publication.path}</small></div>
          <div><span>ACTIVE SNAPSHOT</span><strong>{status ? formatBytes(status.snapshot_size_bytes) : "-"}</strong><small>{status?.snapshot_path || "-"}</small></div>
        </section>
      ) : null}

      {status?.issues.length ? (
        <section className="repository-issues">
          <div className="table-toolbar"><div><p className="eyebrow">HEALTH FINDINGS</p><h2>{status.issues.length} finding{status.issues.length === 1 ? "" : "s"}</h2></div></div>
          {status.issues.map((issue, index) => (
            <div className={`repository-issue ${issue.severity}`} key={`${issue.code}-${index}`}>
              <strong>{issue.code.replaceAll("_", " ")}</strong><span>{issue.message}</span><small>{issue.path}</small>
            </div>
          ))}
        </section>
      ) : null}

      {status?.active_writers.length ? (
        <section className="repository-writers">
          <div className="table-toolbar"><div><p className="eyebrow">ACTIVE EPOCH</p><h2>Registered writers</h2></div></div>
          <div className="table-scroll"><table><thead><tr><th>Employee</th><th>Actor</th><th>Generation</th><th>Published sequence</th><th>Status</th></tr></thead><tbody>
            {status.active_writers.map((writer) => (
              <tr key={writer.actor_id}><td>{writer.employee_number}</td><td title={writer.registration_path}>{writer.actor_id}</td><td>{writer.generation}</td><td>{writer.highest_published_seq}</td><td data-status={writer.state === "healthy" ? "Succeeded" : "Failed"}>{writer.state.replaceAll("_", " ")}</td></tr>
            ))}
          </tbody></table></div>
        </section>
      ) : null}
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
        <div><span>Authoritative system database</span><strong>{status ? `${status.systemDb} · ${status.managerSystemDbWritable ? "Writable" : "Read-only"}` : "-"}</strong></div>
        <div><span>Desktop system database</span><strong>{status ? `${status.desktopSystemDb} · ${status.desktopSystemDbCurrent ? "Current" : "Refresh required"} · ${status.desktopSystemDbReadOnly ? "Read-only" : "Writable"}` : "-"}</strong></div>
        <div><span>Portal executable</span><strong>{status?.portalExe ?? "-"}</strong></div>
      </section>

      <section className="release-controls">
        <div>
          <p className="eyebrow">PUBLISH UPDATE</p>
          <h3>Select the exact update type</h3>
          <p>Every publication refreshes the Desktop system.db from the authoritative Manager copy and makes the distributed copy read-only. A full release is required for the Python runtime, multiple files, or structural changes.</p>
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
  saveInterval,
  openLogs,
  openPublication,
}: {
  status: SyncStatus | null;
  selectedDate: string;
  setSelectedDate: (date: string) => void;
  busy: SourceDataAction | null;
  execute: (action: SourceDataAction) => void;
  saveInterval: (intervalMinutes: number) => Promise<SyncStatus>;
  openLogs: () => void;
  openPublication: () => void;
}) {
  const scheduleRegistered = status?.scheduledTaskRegistered ?? false;
  const taskState = status?.scheduledTaskState ?? "Checking";
  const serviceRunning = status?.schedulerRunning ?? false;
  const [intervalDraft, setIntervalDraft] = useState("");
  const [intervalDirty, setIntervalDirty] = useState(false);
  const [runPage, setRunPage] = useState(1);
  const runs = status?.runs ?? [];
  const runPageSize = 10;
  const runTotalPages = Math.max(1, Math.ceil(runs.length / runPageSize));
  const safeRunPage = Math.min(runPage, runTotalPages);
  const runFirstIndex = (safeRunPage - 1) * runPageSize;
  const pageRuns = runs.slice(runFirstIndex, runFirstIndex + runPageSize);
  const runFirstResult = runs.length ? runFirstIndex + 1 : 0;
  const runLastResult = runs.length ? Math.min(runFirstIndex + runPageSize, runs.length) : 0;

  useEffect(() => {
    if (status?.intervalMinutes === undefined || intervalDirty) return;
    setIntervalDraft(String(status.intervalMinutes));
  }, [intervalDirty, status?.intervalMinutes]);

  const intervalValue = Number(intervalDraft);
  const intervalValid = Number.isInteger(intervalValue) && intervalValue >= 1 && intervalValue <= 1440;
  const saveIntervalSetting = async () => {
    if (!intervalValid) return;
    const response = await saveInterval(intervalValue);
    setIntervalDraft(String(response.intervalMinutes));
    setIntervalDirty(false);
  };

  useEffect(() => {
    setRunPage(1);
  }, [selectedDate, runs.length]);

  return (
    <section className="source-workspace table-focused-workspace">
      <section className={serviceRunning ? "status running" : "status stopped"}>
        <div>
          <p className="eyebrow">SERVING DATA SERVICE</p>
          <h2>{serviceRunning ? "RUNNING" : "STOPPED"}</h2>
          <p>{serviceRunning ? "The serving-table rebuild scheduler is running on this workstation." : "The serving-table rebuild scheduler is not running on this workstation."}</p>
        </div>
        <div className="actions">
          <button className="primary-button" disabled={busy !== null || serviceRunning || !status?.startAllowed} onClick={() => execute("service-start")}><Play size={17} />{busy === "service-start" ? "Starting" : "Start"}</button>
          <button className="danger-button" disabled={busy !== null || !serviceRunning} onClick={() => execute("service-stop")}><Square size={16} />{busy === "service-stop" ? "Stopping" : "Stop"}</button>
          <button className="quiet-button" disabled={busy !== null || serviceRunning} onClick={() => execute("run")}><Play size={16} />{busy === "run" ? "Rebuilding" : "Rebuild now"}</button>
          <button className="quiet-button" disabled={busy !== null || serviceRunning} onClick={() => execute("check")}><CheckCircle2 size={16} />{busy === "check" ? "Checking" : "Check inputs"}</button>
          {scheduleRegistered ? <button className="quiet-button" disabled={busy !== null} onClick={() => execute("schedule-disable")}><CalendarClock size={17} />{busy === "schedule-disable" ? "Removing" : "Disable automatic"}</button> : <button className="primary-button" disabled={busy !== null} onClick={() => execute("schedule-enable")}><CalendarClock size={17} />{busy === "schedule-enable" ? "Enabling" : "Enable automatic"}</button>}
          <button className="quiet-button" onClick={openPublication} disabled={!status?.publishedDatabase}><FolderOpen size={16} />Open publication</button>
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
          <strong>{scheduleRegistered ? `${taskState} - Daily ${status ? formatLocalClock(status.scheduledTaskMinute) : "schedule"} local time` : "Not registered"}</strong>
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

      <section className="source-config-details" aria-label="Source synchronization configuration">
        <span>SYNC SETTINGS</span>
        <strong title={status?.syncSettingsFile || undefined}>{status?.syncSettingsFile ?? "Checking configuration"}</strong>
      </section>

      <section className="source-schedule-settings" aria-label="Source synchronization schedule settings">
        <div>
          <p className="eyebrow">REBUILD INTERVAL</p>
          <h2>Serving-table rebuild frequency</h2>
          <p>Choose how often the scheduler rebuilds the published serving tables during the daily run window.</p>
          <small>Allowed range: 1–1440 minutes. Stop the scheduler before saving a change.</small>
        </div>
        <div className="source-schedule-form">
          <label htmlFor="source-sync-interval">Rebuild every</label>
          <div className="source-schedule-input">
            <input
              id="source-sync-interval"
              type="number"
              min={1}
              max={1440}
              step={1}
              value={intervalDraft}
              onChange={(event) => {
                setIntervalDraft(event.target.value);
                setIntervalDirty(true);
              }}
              aria-describedby="source-sync-interval-help"
              disabled={busy !== null || serviceRunning}
            />
            <span>minutes</span>
          </div>
          <button
            className="primary-button"
            disabled={busy !== null || serviceRunning || !intervalValid || !intervalDirty}
            onClick={() => void saveIntervalSetting()}
          >
            <Save size={16} />
            {busy === "interval-save" ? "Saving" : "Save interval"}
          </button>
          <span id="source-sync-interval-help" className="source-schedule-help">
            {serviceRunning ? "Stop the scheduler to edit this setting." : "Changes apply the next time the scheduler starts."}
          </span>
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
              {pageRuns.map((run, index) => (
                <tr key={[run.startedAt, index].join("-")}>
                  <td data-status={run.status}>{run.status}</td>
                  <td>{formatTimestamp(run.startedAt)}</td>
                  <td>{formatTimestamp(run.finishedAt)}</td>
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
        <footer className="activity-pagination source-sync-pagination"><span>Rows 10</span><strong>{runFirstResult}-{runLastResult} of {runs.length}</strong><div><button className="quiet-button icon-button" aria-label="First synchronization runs page" disabled={safeRunPage === 1} onClick={() => setRunPage(1)}><ChevronsLeft size={16} /></button><button className="quiet-button icon-button" aria-label="Previous synchronization runs page" disabled={safeRunPage === 1} onClick={() => setRunPage(safeRunPage - 1)}><ChevronLeft size={16} /></button><span>Page {safeRunPage} of {runTotalPages}</span><button className="quiet-button icon-button" aria-label="Next synchronization runs page" disabled={safeRunPage === runTotalPages} onClick={() => setRunPage(safeRunPage + 1)}><ChevronRight size={16} /></button><button className="quiet-button icon-button" aria-label="Last synchronization runs page" disabled={safeRunPage === runTotalPages} onClick={() => setRunPage(runTotalPages)}><ChevronsRight size={16} /></button></div></footer>
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
  const [snapshotPage, setSnapshotPage] = useState(1);
  const snapshots = status?.snapshots ?? [];
  const snapshotPageSize = 10;
  const snapshotTotalPages = Math.max(1, Math.ceil(snapshots.length / snapshotPageSize));
  const safeSnapshotPage = Math.min(snapshotPage, snapshotTotalPages);
  const snapshotFirstIndex = (safeSnapshotPage - 1) * snapshotPageSize;
  const pageSnapshots = snapshots.slice(snapshotFirstIndex, snapshotFirstIndex + snapshotPageSize);
  const snapshotFirstResult = snapshots.length ? snapshotFirstIndex + 1 : 0;
  const snapshotLastResult = snapshots.length ? Math.min(snapshotFirstIndex + snapshotPageSize, snapshots.length) : 0;

  useEffect(() => {
    setSnapshotPage(1);
  }, [status?.active_snapshot_id, snapshots.length]);

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
      <section className="snapshot-schedules">
        <section className="retention-controls scheduled-task-controls">
          <div className="retention-readout"><span>Task state</span><strong>{nightlySchedule?.state || "Checking"}</strong></div>
          <div className="retention-readout"><span>Scheduled run</span><strong>{formatScheduleLabel(nightlySchedule?.schedule, `Daily ${formatLocalClock(120)} local time`)}</strong></div>
          <div className="retention-schedule-action">{nightlySchedule?.registered ? <button className="quiet-button" disabled={busy !== null} onClick={() => execute("nightly-schedule-disable")}><CalendarClock size={17} />{busy === "nightly-schedule-disable" ? "Removing" : "Disable"}</button> : <button className="quiet-button" disabled={busy !== null || !nightlySchedule?.automatic_enabled} onClick={() => execute("nightly-schedule-enable")}><CalendarClock size={17} />{busy === "nightly-schedule-enable" ? "Enabling" : "Enable"}</button>}</div>
          <p className="nightly-note">Publishes a verified checkpoint.</p>
        </section>
        <section className="retention-controls scheduled-task-controls">
          <div className="retention-readout"><span>Task state</span><strong>{schedule?.state || "Checking"}</strong></div>
          <div className="retention-readout"><span>Scheduled run</span><strong>{formatScheduleLabel(schedule?.schedule || status?.automatic_schedule, "Checking configuration")}</strong></div>
          <div className="retention-schedule-action">{schedule?.registered ? <button className="quiet-button" disabled={busy !== null} onClick={() => execute("schedule-disable")}><CalendarClock size={17} />{busy === "schedule-disable" ? "Removing" : "Disable"}</button> : <button className="quiet-button" disabled={busy !== null || !schedule?.automatic_enabled} onClick={() => execute("schedule-enable")}><CalendarClock size={17} />{busy === "schedule-enable" ? "Enabling" : "Enable"}</button>}</div>
          <p className="nightly-note">Creates verified backups and removes artifacts older than 90 days.</p>
        </section>
      </section>
      <section className="maintenance-table">
        <div className="table-toolbar"><div><p className="eyebrow">SNAPSHOT HISTORY</p><h2>Verified shared snapshots</h2></div></div>
        <div className="table-scroll"><table className="snapshot-history-table"><thead><tr><th>Created</th><th>Snapshot ID</th><th>Size</th><th>Status</th><th>Location</th></tr></thead><tbody>
          {pageSnapshots.map((snapshot) => <tr key={snapshot.path}><td>{formatTimestamp(snapshot.created_at)}</td><td title={snapshot.path}>{snapshot.snapshot_id}</td><td>{formatBytes(snapshot.size_bytes)}</td><td data-status={snapshot.is_active ? "Succeeded" : ""}>{snapshot.is_active ? "Active" : "Retained"}</td><td><button className="text-button" onClick={() => openLocation(snapshot.path)}>Open location</button></td></tr>)}
          {!status?.snapshots.length && <tr><td colSpan={5} className="empty compact-empty">No snapshots were found.</td></tr>}
        </tbody></table></div>
        <footer className="activity-pagination snapshot-history-pagination"><span>Rows 10</span><strong>{snapshotFirstResult}-{snapshotLastResult} of {snapshots.length}</strong><div><button className="quiet-button icon-button" aria-label="First snapshot history page" disabled={safeSnapshotPage === 1} onClick={() => setSnapshotPage(1)}><ChevronsLeft size={16} /></button><button className="quiet-button icon-button" aria-label="Previous snapshot history page" disabled={safeSnapshotPage === 1} onClick={() => setSnapshotPage(safeSnapshotPage - 1)}><ChevronLeft size={16} /></button><span>Page {safeSnapshotPage} of {snapshotTotalPages}</span><button className="quiet-button icon-button" aria-label="Next snapshot history page" disabled={safeSnapshotPage === snapshotTotalPages} onClick={() => setSnapshotPage(safeSnapshotPage + 1)}><ChevronRight size={16} /></button><button className="quiet-button icon-button" aria-label="Last snapshot history page" disabled={safeSnapshotPage === snapshotTotalPages} onClick={() => setSnapshotPage(snapshotTotalPages)}><ChevronsRight size={16} /></button></div></footer>
      </section>
    </section>
  );
}

function SourceBackupWorkspace({
  status,
  busy,
  execute,
  updateSchedule,
  saveSchedule,
  openPath,
}: {
  status: SourceBackupStatus | null;
  busy: string | null;
  execute: (action: "check" | "workflow" | "refresh" | "backup" | "heartbeat" | "map_tiles") => void;
  updateSchedule: (schedule: "workflow" | "heartbeat", enabled: boolean) => void;
  saveSchedule: (schedule: { workflowTime: string; backupWeekday: string; heartbeatDay: string; heartbeatTime: string }) => void;
  openPath: (path: string) => void;
}) {
  const [workflowTime, setWorkflowTime] = useState("");
  const [backupWeekday, setBackupWeekday] = useState("");
  const [heartbeatDay, setHeartbeatDay] = useState("");
  const [heartbeatTime, setHeartbeatTime] = useState("");
  const [archivePageSize, setArchivePageSize] = useState(10);
  const [archivePage, setArchivePage] = useState(1);
  const running = status?.state?.status === "running";
  const mapTilesProgress = status?.map_tiles_progress;
  const mapTilesRunning = running && (
    status?.state?.action === "map_tiles"
    || mapTilesProgress?.status === "building"
    || mapTilesProgress?.status === "finalizing"
  );
  const latestStatus = !status?.available
    ? "unavailable"
    : status?.refresh_ready === false
      ? "configuration required"
      : status?.state?.status || "ready";
  const latestArchive = status?.archives?.[0];
  const archives = status?.archives ?? [];
  const archiveTotalPages = Math.max(1, Math.ceil(archives.length / archivePageSize));
  const safeArchivePage = Math.min(archivePage, archiveTotalPages);
  const archiveFirstIndex = (safeArchivePage - 1) * archivePageSize;
  const pageArchives = archives.slice(archiveFirstIndex, archiveFirstIndex + archivePageSize);
  const archiveFirstResult = archives.length ? archiveFirstIndex + 1 : 0;
  const archiveLastResult = archives.length ? Math.min(archiveFirstIndex + archivePageSize, archives.length) : 0;
  const unavailableReason = status?.missing_files?.length
    ? `Missing: ${status.missing_files.join(", ")}`
    : "The in-project source-backup scripts are not available.";
  const ordinaryStatusMessage = !status?.available
    ? unavailableReason
    : status?.credential_issues?.length
      ? status.credential_issues.join("; ")
      : status?.state?.details || "The maintained source-backup workflow is ready.";
  const statusMessage = mapTilesRunning && mapTilesProgress?.totalLayers
    ? mapTilesProgress.phase === "staging"
      ? `Preparing map data: ${mapTilesProgress.completedLayers} of ${mapTilesProgress.totalLayers} layers completed.`
      : mapTilesProgress.phase === "encoding"
        ? `${mapTilesProgress.engine === "tippecanoe" ? "Tippecanoe" : "GDAL"} is encoding ${mapTilesProgress.totalLayers} layers into PMTiles.`
        : mapTilesProgress.phase === "merging"
          ? `Merging tile groups into one PMTiles archive.`
          : mapTilesProgress.phase === "validating" || mapTilesProgress.status === "finalizing"
          ? `All ${mapTilesProgress.totalLayers} layers are complete. Validating the archive.`
          : `Building map tiles: ${mapTilesProgress.completedLayers} of ${mapTilesProgress.totalLayers} layers completed.`
    : ordinaryStatusMessage;
  const mapTilesEncoding = mapTilesProgress?.phase === "encoding" || mapTilesProgress?.phase === "merging";
  const mapTilesProgressMaximum = mapTilesEncoding ? 100 : mapTilesProgress?.totalLayers || 1;
  const mapTilesProgressValue = mapTilesEncoding
    ? mapTilesProgress?.phasePercent ?? 0
    : mapTilesProgress?.completedLayers || 0;
  const mapTilesEngineLabel = mapTilesProgress?.engine === "tippecanoe"
    ? `Tippecanoe ${mapTilesProgress.tippecanoeGroupWorkers || 1} group workers / ${mapTilesProgress.tippecanoeThreads || "configured"} threads`
    : mapTilesProgress?.engine === "gdal"
      ? `GDAL ${mapTilesProgress.gdalThreads || "configured"} threads`
      : `${mapTilesProgress?.workerCount || 1} Python workers`;
  const actionLabel = (action: string) => action.replaceAll("_", " ");
  const weekdays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  useEffect(() => {
    if (!status) return;
    setWorkflowTime(status.workflow_time || "00:01");
    setBackupWeekday(status.backup_weekday || "SAT");
    setHeartbeatDay(status.heartbeat_day || "SUN");
    setHeartbeatTime(status.heartbeat_time || "20:00");
  }, [status?.workflow_time, status?.backup_weekday, status?.heartbeat_day, status?.heartbeat_time]);
  useEffect(() => {
    setArchivePage(1);
  }, [archivePageSize, status?.archive_count]);
  const scheduleBusy = busy === "schedule-save";
  return (
    <section className="maintenance-workspace table-focused-workspace source-backup-workspace">
      <div className="module-actions source-backup-actions"><div className="actions">
        <button className="quiet-button" disabled={busy !== null || running || !status?.available} onClick={() => execute("check")}><CheckCircle2 size={17} />Check configuration</button>
        <button className="quiet-button" disabled={busy !== null || running || !status?.available} onClick={() => execute("backup")}><ArchiveRestore size={17} />Backup now</button>
        <button className="quiet-button" disabled={busy !== null || running || !status?.refresh_ready} onClick={() => execute("refresh")}><Database size={17} />Refresh mirrors</button>
        <button className="quiet-button" disabled={busy !== null || running || !status?.map_tiles_available} onClick={() => execute("map_tiles")} title={status?.map_tiles_missing_files?.join("\n") || "Build registered PMTiles archives from local DuckDB mirrors"}><MapIcon size={17} />{busy === "map_tiles" ? "Building tiles" : "Build map tiles"}</button>
        <button className="primary-button" disabled={busy !== null || running || !status?.refresh_ready} onClick={() => execute("workflow")}><Play size={17} />Run workflow</button>
        <button className="primary-button" disabled={busy !== null || scheduleBusy} onClick={() => saveSchedule({ workflowTime, backupWeekday, heartbeatDay, heartbeatTime })}>{scheduleBusy ? "Saving..." : "Save configuration"}</button>
      </div></div>
      <section className={`${latestStatus === "failed" || latestStatus === "unavailable" || latestStatus === "configuration required" ? "status stopped" : "status running"} compact-status${mapTilesRunning && mapTilesProgress?.totalLayers ? " map-tiles-running-status" : ""}`}>
        <div><p className="eyebrow">SOURCE MIRROR AND ARCHIVE WORKFLOW</p><h2>{latestStatus.toUpperCase()}</h2></div>
        {mapTilesRunning && mapTilesProgress?.totalLayers ? (
          <aside className="map-tiles-build-progress">
            <div><strong>{statusMessage}</strong><span>{mapTilesEngineLabel}</span></div>
            <progress max={mapTilesProgressMaximum} value={mapTilesProgressValue} />
            <small>{mapTilesProgress.activeLayers?.length ? `Active: ${mapTilesProgress.activeLayers.map((layer) => layer.id).join(", ")}` : mapTilesProgress.message || "Finalizing archive"}</small>
          </aside>
        ) : <p>{statusMessage}</p>}
      </section>
      <section className="metrics maintenance-metrics">
        <div><span>DATABASE MIRRORS</span><strong>{status?.database_count ?? "-"}</strong></div>
        <div><span>RETAINED ARCHIVES</span><strong>{status?.archive_count ?? "-"}</strong></div>
        <div><span>RETENTION</span><strong>{status?.retention_days ? `${status.retention_days} days` : "-"}</strong></div>
        <div><span>LATEST ARCHIVE</span><strong>{latestArchive ? formatTimestamp(latestArchive.modified_at) : "None"}</strong></div>
      </section>
      <section className="source-backup-schedules">
        <article className="retention-controls scheduled-task-controls">
          <div className="retention-readout"><span>Daily workflow</span><strong>{status?.workflow_schedule?.state || "Checking"}</strong></div>
          <label className="schedule-input"><span>Run time</span><input type="time" value={workflowTime} onChange={(event) => setWorkflowTime(event.target.value)} disabled={busy !== null} /></label>
          <label className="schedule-input"><span>Archive day</span><select value={backupWeekday} onChange={(event) => setBackupWeekday(event.target.value)} disabled={busy !== null}>{weekdays.map((day) => <option key={day} value={day}>{day}</option>)}</select></label>
          <div className="retention-schedule-action">
            <button className="quiet-button" disabled={busy !== null} onClick={() => updateSchedule("workflow", true)}><CalendarClock size={17} />{status?.workflow_schedule?.registered ? "Update task" : "Enable"}</button>
            {status?.workflow_schedule?.registered && <button className="danger-button" disabled={busy !== null} onClick={() => updateSchedule("workflow", false)}>Disable</button>}
          </div>
          <p className="nightly-note">The clean SQL Server mirror rebuild runs daily. The retained archive, Spatial Data Warehouse refresh, and PMTiles rebuild run on the selected archive day.</p>
        </article>
        <article className="retention-controls scheduled-task-controls">
          <div className="retention-readout"><span>Heartbeat</span><strong>{status?.heartbeat_schedule?.state || "Checking"}</strong></div>
          <label className="schedule-input"><span>Run day</span><select value={heartbeatDay} onChange={(event) => setHeartbeatDay(event.target.value)} disabled={busy !== null}>{weekdays.map((day) => <option key={day} value={day}>{day}</option>)}</select></label>
          <label className="schedule-input"><span>Run time</span><input type="time" value={heartbeatTime} onChange={(event) => setHeartbeatTime(event.target.value)} disabled={busy !== null} /></label>
          <div className="retention-schedule-action">
            <button className="quiet-button" disabled={busy !== null} onClick={() => updateSchedule("heartbeat", true)}><CalendarClock size={17} />{status?.heartbeat_schedule?.registered ? "Update task" : "Enable"}</button>
            {status?.heartbeat_schedule?.registered && <button className="danger-button" disabled={busy !== null} onClick={() => updateSchedule("heartbeat", false)}>Disable</button>}
          </div>
          <p className="nightly-note">Confirms that the workstation and scheduled task are available. <button className="text-button" disabled={busy !== null || running} onClick={() => execute("heartbeat")}>Send a test now</button></p>
        </article>
      </section>
      <section className="source-backup-tables">
        <section className="maintenance-table">
          <div className="table-toolbar"><div><p className="eyebrow">RECENT RUNS</p><h2>{status?.runs?.length ?? 0} recorded tasks</h2></div>{status?.log_directory && <button className="quiet-button" onClick={() => openPath(status.log_directory)}><FolderOpen size={17} />Open logs</button>}</div>
          <div className="table-scroll"><table className="source-runs-table"><thead><tr><th>Started</th><th>Action</th><th>Status</th><th>Duration</th><th>Details</th></tr></thead><tbody>
            {(status?.runs ?? []).map((run) => <tr key={run.run_id}><td>{formatTimestamp(run.started_at)}</td><td>{actionLabel(run.action)}</td><td data-status={run.status}>{run.status}</td><td>{formatDuration(run.duration_seconds)}</td><td title={`${run.details}\n${run.log_path}`}>{run.details}</td></tr>)}
            {!status?.runs?.length && <tr><td colSpan={5} className="empty compact-empty">No source-backup tasks have been recorded.</td></tr>}
          </tbody></table></div>
        </section>
        <section className="maintenance-table">
          <div className="table-toolbar"><div><p className="eyebrow">SOURCE ARCHIVES</p><h2>{status?.archive_count ?? archives.length} recent files</h2></div>{status?.backup_directory && <button className="quiet-button" onClick={() => openPath(status.backup_directory!)}><FolderOpen size={17} />Open backups</button>}</div>
          <div className="table-scroll"><table className="source-archives-table"><thead><tr><th>Created</th><th>Archive</th><th>Size</th></tr></thead><tbody>
            {pageArchives.map((archive) => <tr key={archive.path}><td>{formatTimestamp(archive.modified_at)}</td><td><button className="text-button" onClick={() => openPath(archive.path)}>{archive.name}</button></td><td>{formatBytes(archive.size_bytes)}</td></tr>)}
            {!status?.archives?.length && <tr><td colSpan={3} className="empty compact-empty">No source-data archives were found.</td></tr>}
          </tbody></table></div>
          <footer className="activity-pagination source-archives-pagination"><label>Rows<select value={archivePageSize} onChange={(event) => setArchivePageSize(Number(event.target.value))}>{[10, 15].map((size) => <option key={size} value={size}>{size}</option>)}</select></label><strong>{archiveFirstResult}-{archiveLastResult} of {archives.length}</strong><div><button className="quiet-button icon-button" aria-label="First archive page" disabled={safeArchivePage === 1} onClick={() => setArchivePage(1)}><ChevronsLeft size={16} /></button><button className="quiet-button icon-button" aria-label="Previous archive page" disabled={safeArchivePage === 1} onClick={() => setArchivePage(safeArchivePage - 1)}><ChevronLeft size={16} /></button><span>Page {safeArchivePage} of {archiveTotalPages}</span><button className="quiet-button icon-button" aria-label="Next archive page" disabled={safeArchivePage === archiveTotalPages} onClick={() => setArchivePage(safeArchivePage + 1)}><ChevronRight size={16} /></button><button className="quiet-button icon-button" aria-label="Last archive page" disabled={safeArchivePage === archiveTotalPages} onClick={() => setArchivePage(archiveTotalPages)}><ChevronsRight size={16} /></button></div></footer>
        </section>
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
        {pageBackups.map((backup) => <tr key={backup.path}><td>{formatTimestamp(backup.modified_at)}</td><td title={backup.name}>{friendlyBackupName(backup.name)}</td><td>{formatBytes(backup.size_bytes)}</td><td><button className="text-button" onClick={() => openPath(backup.path)}>Open location</button></td></tr>)}
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
        {(status?.conflicts ?? []).map((conflict) => <tr key={conflict.conflict_id}><td>{conflict.conflict_id}</td><td>{conflict.entity_type}</td><td>{conflict.entity_id}</td><td data-status={conflict.state === "open" ? "Failed" : "Succeeded"}>{conflict.state}</td><td>{formatTimestamp(conflict.detected_at)}</td><td>{conflict.selected_operation_id || "-"}</td></tr>)}
        {!status?.conflicts.length && <tr><td colSpan={6} className="empty">No conflicts were found in the active snapshot.</td></tr>}
      </tbody></table></div></section>
    </section>
  );
}

function LogsWorkspace({ status, busy, selectedDate, setSelectedDate, openPath }: { status: LogStatus | null; busy: boolean; selectedDate: string; setSelectedDate: (value: string) => void; openPath: (path: string) => void }) {
  return <section className="maintenance-workspace table-focused-workspace"><div className="module-actions"><div className="actions"><button className="quiet-button" disabled={!status?.log_directory} onClick={() => openPath(status?.log_directory || "")}><FolderOpen size={17} />Open log folder</button></div></div><section className="metrics maintenance-metrics"><div><span>EVENTS</span><strong>{status?.events.length ?? "-"}</strong></div><div><span>RETENTION</span><strong>{status?.retention_days ?? "-"} days</strong></div><div><span>DATE</span><strong>{formatDate(selectedDate)}</strong></div><div><span>LOG FILE</span><strong>{busy ? "Loading" : status?.log_path ? "Available" : "Checking"}</strong></div></section><section className="maintenance-table"><div className="table-toolbar"><div><p className="eyebrow">WORKSTATION EVENTS</p><h2>{formatDate(selectedDate)}</h2></div><label>Date<input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} /></label></div><div className="table-scroll"><table><thead><tr><th>Recorded</th><th>Task</th><th>Status</th><th>Details</th></tr></thead><tbody>{(status?.events ?? []).map((event, index) => <tr key={`${event.recorded_at}-${index}`}><td>{formatTimestamp(event.recorded_at)}</td><td>{event.task}</td><td data-status={event.status}>{event.status}</td><td>{event.details}</td></tr>)}{!status?.events.length && <tr><td colSpan={4} className="empty">No workstation events were recorded for this date.</td></tr>}</tbody></table></div></section></section>;
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
  const [authorization, setAuthorization] = useState<ManagerAuthorization>("checking");
  const [authorizationError, setAuthorizationError] = useState("");
  const [authorizedUser, setAuthorizedUser] = useState<PortalUser | null>(null);
  const [workspace, setWorkspace] = useState<ManagerWorkspace>("hub");
  const [activePage, setActivePage] = useState<PageId>("overview");
  const [selectedDate, setSelectedDate] = useState(today);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [repositoryStatus, setRepositoryStatus] = useState<RepositoryStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<SourceDataAction | null>(null);
  const [repositoryBusy, setRepositoryBusy] = useState<"refresh" | "browse" | "inspect" | "validate" | "configure" | "bootstrap" | null>(null);
  const [repositoryNetworkRoot, setRepositoryNetworkRoot] = useState("");
  const [configuredRepositoryRoot, setConfiguredRepositoryRoot] = useState("");
  const [releaseStatus, setReleaseStatus] = useState<PortalReleaseStatus | null>(null);
  const [releaseMode, setReleaseMode] = useState<"system-db" | "portal-exe" | "full">("full");
  const [releaseVersion, setReleaseVersion] = useState("");
  const [releaseBusy, setReleaseBusy] = useState(false);
  const [releaseProgress, setReleaseProgress] = useState("");
  const [releaseSuccess, setReleaseSuccess] = useState("");
  const [schemaStatus, setSchemaStatus] = useState<SchemaStatus | null>(null);
  const [schemaCatalog, setSchemaCatalog] = useState<SchemaCatalog | null>(null);
  const [schemaPlan, setSchemaPlan] = useState<SchemaPlan | null>(null);
  const [schemaBusy, setSchemaBusy] = useState<string | null>(null);
  const [schemaConfirmation, setSchemaConfirmation] = useState("");
  const [snapshotStatus, setSnapshotStatus] = useState<SnapshotStatus | null>(null);
  const [retentionScheduleStatus, setRetentionScheduleStatus] = useState<RetentionScheduleStatus | null>(null);
  const [nightlyScheduleStatus, setNightlyScheduleStatus] = useState<NightlyScheduleStatus | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState<string | null>(null);
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [backupBusy, setBackupBusy] = useState<string | null>(null);
  const [sourceBackupStatus, setSourceBackupStatus] = useState<SourceBackupStatus | null>(null);
  const [sourceBackupBusy, setSourceBackupBusy] = useState<string | null>(null);
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

  useEffect(() => {
    let cancelled = false;

    async function authorizeManager() {
      setAuthorization("checking");
      setAuthorizationError("");
      try {
        const session = await invoke<ManagerStartupSession>("manager_startup_session");
        if (!session.token) throw new Error("Portal Manager did not receive an authorization token.");
        saveManagementToken(session.token, session.user.selected_role);
        saveManagementUser(session.user);
        if (!cancelled) {
          setAuthorizedUser(session.user);
          setWorkspace("hub");
          setAuthorization("authorized");
        }
      } catch (reason) {
        clearManagementToken();
        if (!cancelled) {
          setAuthorizedUser(null);
          setAuthorization("denied");
          setAuthorizationError(reason instanceof Error ? reason.message : String(reason));
        }
      }
    }

    void authorizeManager();
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (authorization !== "authorized") return;
    try {
      const response = await invoke<SyncStatus>("sync_status", { selectedDate });
      setStatus(response);
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }, [authorization, selectedDate]);

  useEffect(() => {
    if (authorization !== "authorized") return;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(interval);
  }, [authorization, refresh]);

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
      setConfiguredRepositoryRoot(response.network_root);
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

  const schemaTask = useCallback(async (task: "status" | "validate" | "plan" | "register" | "initialize" | "migrate", confirmation?: string) => {
    setSchemaBusy(task);
    try {
      const command = task === "status" ? "schema_status" : task === "validate" ? "validate_schema" : task === "plan" ? "plan_schema" : task === "register" ? "register_schema" : task === "initialize" ? "initialize_schema" : "migrate_schema";
      if (task === "register") {
        await invoke(command);
        const [statusResponse, planResponse, catalogResponse] = await Promise.all([
          invoke<SchemaStatus>("schema_status"),
          invoke<SchemaPlan>("plan_schema"),
          invoke<SchemaCatalog>("schema_catalog"),
        ]);
        setSchemaStatus(statusResponse);
        setSchemaPlan(planResponse);
        setSchemaCatalog(catalogResponse);
        setError("");
        return;
      }
      const response = await invoke<SchemaStatus | SchemaPlan>(command, confirmation === undefined ? {} : { confirmation });
      if (task === "plan") setSchemaPlan(response as SchemaPlan);
      else setSchemaStatus(response as SchemaStatus);
      if (task === "initialize" || task === "migrate") {
        setSchemaConfirmation("");
        setSchemaPlan(null);
        setSchemaCatalog(await invoke<SchemaCatalog>("schema_catalog"));
      }
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSchemaBusy(null);
    }
  }, []);

  useEffect(() => {
    if (activePage === "schema") {
      void schemaTask("status");
      void invoke<SchemaCatalog>("schema_catalog")
        .then(setSchemaCatalog)
        .catch((reason) => setError(String(reason)));
    }
  }, [activePage, schemaTask]);

  const saveSchemaDraft = useCallback(async (operations: SchemaDraftOperation[]) => {
    if (!schemaCatalog) return;
    setSchemaBusy("draft");
    try {
      const response = await invoke<SchemaCatalog>("save_schema_draft", {
        baseReleaseId: schemaCatalog.base_release_id,
        operations,
      });
      setSchemaCatalog(response);
      setSchemaPlan(null);
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSchemaBusy(null);
    }
  }, [schemaCatalog]);

  const discardSchemaDraft = useCallback(async () => {
    if (!(await appConfirm(
      "Discard every unpublished schema draft change?",
      { title: "Discard schema draft", kind: "warning", confirmLabel: "Discard draft" },
    ))) return;
    setSchemaBusy("draft");
    try {
      setSchemaCatalog(await invoke<SchemaCatalog>("discard_schema_draft"));
      setSchemaPlan(null);
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSchemaBusy(null);
    }
  }, []);

  const testSchemaDraft = useCallback(async () => {
    setSchemaBusy("test");
    try {
      setSchemaCatalog(await invoke<SchemaCatalog>("test_schema_draft"));
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSchemaBusy(null);
    }
  }, []);

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

  const loadSourceBackupStatus = useCallback(async () => {
    const response = await invoke<SourceBackupStatus>("source_backup_status");
    setSourceBackupStatus(response);
    return response;
  }, []);

  const executeSourceBackup = async (action: "check" | "workflow" | "refresh" | "backup" | "heartbeat" | "map_tiles") => {
    const confirmations: Partial<Record<typeof action, { message: string; title: string; confirmLabel: string }>> = {
      workflow: {
        title: "Run source-backup workflow",
        confirmLabel: "Run workflow",
        message: "Run the maintained source workflow now? The configured DuckDB mirrors will be rebuilt. On the weekly archive day, the current files are archived first, then the SDW mirror and validated PMTiles archive are rebuilt.",
      },
      refresh: {
        title: "Refresh source mirrors",
        confirmLabel: "Refresh mirrors",
        message: "Rebuild every configured SQL Server DuckDB mirror now? Existing mirror files are replaced only by this registered workflow.",
      },
      backup: {
        title: "Create source-data backup",
        confirmLabel: "Create backup",
        message: "Create the retained source-data archive now? An existing archive for today will be replaced.",
      },
      heartbeat: {
        title: "Send heartbeat test",
        confirmLabel: "Send test",
        message: "Send a machine-online heartbeat email to the configured recipients now?",
      },
      map_tiles: {
        title: "Build Portal map tiles",
        confirmLabel: "Build map tiles",
        message: "Generate every enabled PMTiles archive from the registered local DuckDB mirrors? Existing archives will be replaced only after each new archive passes validation.",
      },
    };
    const confirmation = confirmations[action];
    if (confirmation && !(await appConfirm(confirmation.message, {
      title: confirmation.title,
      confirmLabel: confirmation.confirmLabel,
      kind: action === "refresh" || action === "workflow" || action === "map_tiles" ? "warning" : "default",
    }))) return;
    setSourceBackupBusy(action);
    try {
      await invoke("run_source_backup", { action });
      await new Promise((resolve) => window.setTimeout(resolve, 400));
      await loadSourceBackupStatus();
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSourceBackupBusy(null);
    }
  };

  const updateSourceBackupSchedule = async (schedule: "workflow" | "heartbeat", enabled: boolean) => {
    if (!enabled && !(await appConfirm(
      `Disable the ${schedule === "workflow" ? "daily source workflow" : "machine heartbeat"} scheduled task?`,
      { title: "Disable scheduled task", kind: "warning", confirmLabel: "Disable task" },
    ))) return;
    setSourceBackupBusy(`${schedule}-${enabled ? "enable" : "disable"}`);
    try {
      const response = await invoke<SourceBackupStatus>("set_source_backup_schedule", { schedule, enabled });
      setSourceBackupStatus(response);
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSourceBackupBusy(null);
    }
  };

  const saveSourceBackupSchedule = async (schedule: {
    workflowTime: string;
    backupWeekday: string;
    heartbeatDay: string;
    heartbeatTime: string;
  }) => {
    setSourceBackupBusy("schedule-save");
    try {
      const response = await invoke<SourceBackupStatus>("save_source_backup_schedule", schedule);
      setSourceBackupStatus(response);
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSourceBackupBusy(null);
    }
  };

  useEffect(() => {
    if (activePage !== "source-backup") return;
    void loadSourceBackupStatus().catch((reason) => setError(String(reason)));
    const interval = window.setInterval(() => {
      void loadSourceBackupStatus().catch((reason) => setError(String(reason)));
    }, 3000);
    return () => window.clearInterval(interval);
  }, [activePage, loadSourceBackupStatus]);

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
            : action === "schedule-disable"
              ? "disable_source_scheduler_schedule"
              : action === "run"
                ? "run_source_sync"
                : "check_source_sync";
      await invoke(command);
      await new Promise((resolve) => window.setTimeout(resolve, action === "service-start" ? 900 : 350));
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  const saveSourceSyncInterval = async (intervalMinutes: number): Promise<SyncStatus> => {
    setBusy("interval-save");
    try {
      const response = await invoke<SyncStatus>("update_source_sync_interval", {
        intervalMinutes,
        selectedDate,
      });
      setStatus(response);
      setError("");
      return response;
    } catch (reason) {
      setError(String(reason));
      throw reason;
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

  const browseRepository = async () => {
    setRepositoryBusy("browse");
    try {
      const selected = await invoke<string | null>("browse_repository_folder", {
        initialPath: repositoryNetworkRoot.trim() || undefined,
      });
      if (selected) {
        setRepositoryNetworkRoot(selected);
        const response = await invoke<RepositoryStatus>("inspect_repository", { networkRoot: selected });
        setRepositoryStatus(response);
      }
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRepositoryBusy(null);
    }
  };

  const inspectRepository = async (networkRoot: string) => {
    setRepositoryBusy("inspect");
    try {
      const response = await invoke<RepositoryStatus>("inspect_repository", { networkRoot });
      setRepositoryStatus(response);
      setRepositoryNetworkRoot(response.network_root);
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRepositoryBusy(null);
    }
  };

  const validateRepository = async () => {
    setRepositoryBusy("validate");
    try {
      const response = await invoke<RepositoryStatus>("validate_repository", { networkRoot: repositoryNetworkRoot.trim() || undefined });
      setRepositoryStatus(response);
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRepositoryBusy(null);
    }
  };

  const configureRepository = async (networkRoot: string, confirmation: string) => {
    setRepositoryBusy("configure");
    try {
      const response = await invoke<RepositoryStatus>("configure_repository", { networkRoot, confirmation });
      setRepositoryStatus(response);
      setRepositoryNetworkRoot(response.network_root);
      setConfiguredRepositoryRoot(response.network_root);
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRepositoryBusy(null);
    }
  };

  const bootstrapRepository = async (networkRoot: string, confirmation: string) => {
    if (!networkRoot) {
      return;
    }
    if (activePage === "source-backup") {
      void loadSourceBackupStatus().catch((reason) => setError(String(reason)));
      return;
    }
    setRepositoryBusy("bootstrap");
    try {
      const response = await invoke<RepositoryStatus>("bootstrap_repository", {
        networkRoot,
        confirmation,
      });
      setRepositoryStatus(response);
      setRepositoryNetworkRoot(response.network_root);
      setConfiguredRepositoryRoot(response.network_root);
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
    if (!(await appConfirm(
      `Publish ${label} as release ${version ?? releaseStatus?.packageVersion ?? ""}?`,
      { title: "Publish Portal release", kind: "warning", confirmLabel: "Publish release" },
    ))) {
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

  if (authorization !== "authorized") {
    return (
      <main className="manager-access-gate">
        <section className="manager-access-panel">
          <p className="eyebrow">PORTAL WORKSTATION MANAGER</p>
          <h1>{authorization === "checking" ? "CHECKING ACCESS" : "ACCESS DENIED"}</h1>
          <p>
            {authorization === "checking"
              ? "Verifying the signed-in Windows account and Portal role."
              : authorizationError || "Only active Portal Admin and System Admin accounts may use Portal Manager."}
          </p>
          {authorization === "denied" ? (
            <button className="primary-button" onClick={() => window.location.reload()}>
              Check again
            </button>
          ) : null}
        </section>
      </main>
    );
  }

  if (workspace === "hub") {
    return (
      <ManagerWorkspaceHub
        onSelectAdministration={() => setWorkspace("portal-admin")}
        onSelectMaintenance={() => {
          setError("");
          setActivePage("overview");
          setWorkspace("maintenance");
        }}
        status={status}
        user={authorizedUser}
      />
    );
  }

  if (workspace === "portal-admin") {
    return <PortalAdministrationPage onBack={() => setWorkspace("hub")} />;
  }

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
          <div className="app-header-actions">
            <button className="quiet-button" onClick={() => setWorkspace("hub")} title="Return to workspace selection">
              <ArrowLeft size={17} />
              Workspaces
            </button>
            {canRefresh && (
              <button className="quiet-button" onClick={refreshActivePage} title="Refresh status">
                <RefreshCw size={18} />
                Refresh
              </button>
            )}
          </div>
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
            saveInterval={saveSourceSyncInterval}
            openLogs={() => void openLogs()}
            openPublication={() => void openPath(status?.publishedDatabase ?? "")}
            selectedDate={selectedDate}
            setSelectedDate={setSelectedDate}
            status={status}
          />
        )}
        {activePage === "source-backup" && (
          <SourceBackupWorkspace
            busy={sourceBackupBusy}
            execute={(action) => void executeSourceBackup(action)}
            openPath={(path) => void openPath(path)}
            saveSchedule={(schedule) => void saveSourceBackupSchedule(schedule)}
            status={sourceBackupStatus}
            updateSchedule={(schedule, enabled) => void updateSourceBackupSchedule(schedule, enabled)}
          />
        )}
        {activePage === "repository" && (
          <RepositoryWorkspace
            bootstrap={(networkRoot, confirmation) => void bootstrapRepository(networkRoot, confirmation)}
            browse={() => void browseRepository()}
            busy={repositoryBusy}
            configure={(networkRoot, confirmation) => void configureRepository(networkRoot, confirmation)}
            configuredNetworkRoot={configuredRepositoryRoot}
            inspect={(networkRoot) => void inspectRepository(networkRoot)}
            networkRoot={repositoryNetworkRoot}
            openPath={(path) => void openPath(path)}
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
            catalog={schemaCatalog}
            confirmation={schemaConfirmation}
            discardDraft={discardSchemaDraft}
            execute={(action) => void schemaTask(action, schemaConfirmation)}
            loadPlan={() => void schemaTask("plan")}
            plan={schemaPlan}
            register={async () => {
              if (await appConfirm(
                "Register these additive draft changes as the next stormwater.db schema release? You can review the migration plan before publishing.",
                { title: "Register schema release", confirmLabel: "Register changes" },
              )) {
                void schemaTask("register");
              }
            }}
            saveDraft={saveSchemaDraft}
            setConfirmation={setSchemaConfirmation}
            status={schemaStatus}
            testDraft={() => void testSchemaDraft()}
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
