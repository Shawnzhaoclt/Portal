import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  BookOpen,
  CalendarDays,
  Database,
  Edit3,
  FolderTree,
  KeyRound,
  LayoutDashboard,
  RefreshCw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { formatDateTime } from "../../../ui/src/lib/dateTime";
import { appConfirm, appPrompt } from "../messageDialogService";

export type Role = "user" | "admin" | "system_admin" | "manager";

export type Actor = {
  id: string;
  name: string;
  email: string;
  team_name?: string | null;
  roles: Role[];
  selected_role: Role;
};

type Summary = {
  users: number;
  teams: number;
  resources: number;
  permissions: number;
  dictionaries: number;
  audit_events: number;
};

type UserRow = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  email?: string | null;
  employee_id?: string | null;
  team_id?: string | null;
  team_name?: string | null;
  is_active?: boolean | number;
  is_admin?: boolean | number;
  is_system_admin?: boolean | number;
  updated_at?: string | null;
};

type TeamRow = {
  id: string;
  name: string;
  description?: string | null;
  parent_team_id?: string | null;
  parent_name?: string | null;
  manager_user_id?: string | null;
  manager_name?: string | null;
  member_count?: number;
  is_active?: boolean | number;
  updated_at?: string | null;
};

type ResourceRow = {
  id: string;
  resource_id?: string | null;
  resource_key?: string | null;
  name: string;
  resource_type?: string | null;
  url?: string | null;
  category?: string | null;
  description?: string | null;
  is_public?: boolean | number;
  is_active?: boolean | number;
};

type PermissionRow = {
  id: string;
  resource_record_id?: string | null;
  resource_id?: string | null;
  resource_key?: string | null;
  resource_name?: string | null;
  url?: string | null;
  user_id?: string | null;
  user_name?: string | null;
  team_id?: string | null;
  team_name?: string | null;
  permission_level?: number | string | null;
};

type DictionaryItem = {
  id: string;
  item_code?: string | null;
  label: string;
  sort_order?: number;
  is_active?: boolean | number;
  metadata_json?: string | null;
};

type DictionaryRow = {
  id: string;
  dictionary_key: string;
  name: string;
  description?: string | null;
  is_active?: boolean | number;
  items: DictionaryItem[];
};

type HolidayRow = {
  id: string;
  holiday_name?: string | null;
  holiday_date?: string | null;
  actual_date?: string | null;
  observed_date?: string | null;
  holiday_hours?: number | null;
  day_type?: string | null;
  is_active?: boolean | number;
  reduces_weekly_target?: boolean | number;
  extends_deadline?: boolean | number;
  notes?: string | null;
};

type AuditRow = {
  id?: string;
  event_type?: string | null;
  action?: string | null;
  actor_name?: string | null;
  actor_email?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  created_at?: string | null;
  details_json?: string | null;
};

type HolidayPayload = {
  available?: boolean;
  calendars?: Array<Record<string, unknown>>;
  holidays?: HolidayRow[];
};

type RunnerResponse<T> = {
  ok: boolean;
  result?: T;
  error?: string;
};

export type PortalAdministrationToolbar = {
  actor: Actor | null;
  selectedRole: Role;
  loading: boolean;
  onRoleChange: (role: Role) => void;
  onRefresh: () => void;
};

type Section = "overview" | "users" | "teams" | "resources" | "permissions" | "dictionaries" | "holidays" | "audit";

type NavigationItem = {
  id: Section;
  label: string;
  icon: LucideIcon;
};

const NAVIGATION: NavigationItem[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "users", label: "Users", icon: Users },
  { id: "teams", label: "Teams", icon: FolderTree },
  { id: "resources", label: "Resources", icon: Database },
  { id: "permissions", label: "Permissions", icon: KeyRound },
  { id: "dictionaries", label: "Dictionaries", icon: BookOpen },
  { id: "holidays", label: "Holidays", icon: CalendarDays },
  { id: "audit", label: "Audit", icon: Activity },
];

const PERMISSION_NAMES: Array<[number, string]> = [
  [1, "View"],
  [2, "Edit"],
  [4, "Manage"],
  [8, "Admin"],
  [16, "Review"],
  [32, "Create"],
  [64, "Delete"],
];

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function displayDate(value: unknown): string {
  return formatDateTime(value === null || value === undefined ? null : String(value));
}

function textValue(value: unknown, fallback = "-"): string {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function displayRole(role: string | undefined): string {
  return role === "system_admin" ? "System admin" : role ? role.replace("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "User";
}

async function promptText(label: string, current = ""): Promise<string | null> {
  const value = await appPrompt(label, { defaultValue: current, title: label, confirmLabel: "Continue" });
  return value === null ? null : value.trim();
}

async function promptNumber(label: string, current = "0"): Promise<number | null> {
  const value = await promptText(label, current);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function permissionText(level: unknown): string {
  const numeric = Number(level || 0);
  const labels = PERMISSION_NAMES.filter(([bit]) => (numeric & bit) === bit).map(([, label]) => label);
  return labels.length ? labels.join(", ") : "None";
}

async function managementCall<T>(action: string, role: Role | "", data: Record<string, unknown> = {}): Promise<T> {
  const response = await invoke<RunnerResponse<T>>("management_request", {
    request: { action, data, selectedRole: role || undefined },
  });
  if (!response.ok) throw new Error(response.error || `Management action failed: ${action}`);
  return response.result as T;
}

type TableColumn<T> = {
  label: string;
  render: (row: T) => ReactNode;
  className?: string;
};

function AdminTable<T extends { id?: string | null }>({
  columns,
  rows,
  empty = "No records found.",
  actions,
}: {
  columns: TableColumn<T>[];
  rows: T[];
  empty?: string;
  actions?: (row: T) => ReactNode;
}) {
  return (
    <div className="manager-admin-table-wrap">
      <table className="manager-admin-table">
        <thead>
          <tr>
            {columns.map((column) => <th className={column.className} key={column.label}>{column.label}</th>)}
            {actions ? <th className="manager-admin-actions-heading">Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.map((row, index) => (
            <tr key={row.id || String(index)}>
              {columns.map((column) => <td className={column.className} key={column.label}>{column.render(row)}</td>)}
              {actions ? <td className="manager-admin-actions-cell"><div className="manager-admin-action-list">{actions(row)}</div></td> : null}
            </tr>
          )) : (
            <tr><td className="manager-admin-empty" colSpan={columns.length + (actions ? 1 : 0)}>{empty}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ActionButton({
  label,
  icon: Icon,
  onClick,
  disabled = false,
  danger = false,
}: {
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button className={`manager-admin-action-button${danger ? " danger" : ""}`} disabled={disabled} onClick={onClick} title={label}>
      {Icon ? <Icon size={14} strokeWidth={1.8} /> : null}
      <span>{label}</span>
    </button>
  );
}

export default function PortalAdministrationWorkspace({ onToolbarChange }: { onToolbarChange: (toolbar: PortalAdministrationToolbar | null) => void }) {
  const [actor, setActor] = useState<Actor | null>(null);
  const [summary, setSummary] = useState<Summary>({ users: 0, teams: 0, resources: 0, permissions: 0, dictionaries: 0, audit_events: 0 });
  const [selectedRole, setSelectedRole] = useState<Role>("admin");
  const [section, setSection] = useState<Section>("overview");
  const [users, setUsers] = useState<UserRow[]>([]);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [resources, setResources] = useState<ResourceRow[]>([]);
  const [permissions, setPermissions] = useState<PermissionRow[]>([]);
  const [dictionaries, setDictionaries] = useState<DictionaryRow[]>([]);
  const [holidays, setHolidays] = useState<HolidayRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [releaseVersion, setReleaseVersion] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState("");

  const loadData = useCallback(async (role: Role) => {
    const [nextSummary, nextUsers, nextTeams, nextResources, nextPermissions, nextDictionaries, nextHolidays, nextAudit] = await Promise.all([
      managementCall<Summary>("summary", role),
      managementCall<UserRow[]>("users_list", role),
      managementCall<TeamRow[]>("teams_list", role),
      managementCall<ResourceRow[]>("resources_list", role),
      managementCall<PermissionRow[]>("permissions_list", role),
      managementCall<DictionaryRow[]>("dictionaries_list", role),
      managementCall<HolidayPayload>("holidays_list", role),
      managementCall<AuditRow[]>("audit_list", role),
    ]);
    setSummary(nextSummary);
    setUsers(nextUsers);
    setTeams(nextTeams);
    setResources(nextResources);
    setPermissions(nextPermissions);
    setDictionaries(nextDictionaries);
    setHolidays(nextHolidays?.holidays || []);
    setAudit(nextAudit);
  }, []);

  const refresh = useCallback(async (role = selectedRole) => {
    setLoading(true);
    setError("");
    try {
      await loadData(role);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [loadData, selectedRole]);

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      setLoading(true);
      try {
        const context = await managementCall<{ actor: Actor; summary: Summary }>("context", "");
        if (cancelled) return;
        const role = context.actor.selected_role || context.actor.roles.find((item) => item === "system_admin" || item === "admin") || "admin";
        setActor(context.actor);
        setSelectedRole(role);
        await loadData(role);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void initialize();
    return () => { cancelled = true; };
  }, [loadData]);

  const canManage = selectedRole === "admin" || selectedRole === "system_admin";
  const isSystemAdmin = selectedRole === "system_admin";

  async function runAction(action: string, data: Record<string, unknown>, message: string) {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      await managementCall(action, selectedRole, data);
      setNotice(message);
      await refresh(selectedRole);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  const changeRole = useCallback(async (role: Role) => {
    setSelectedRole(role);
    setNotice(`Viewing Portal as ${displayRole(role)}.`);
    await refresh(role);
  }, [refresh]);

  useEffect(() => {
    onToolbarChange({
      actor,
      selectedRole,
      loading,
      onRoleChange: (role) => { void changeRole(role); },
      onRefresh: () => { void refresh(); },
    });
  }, [actor, changeRole, loading, onToolbarChange, refresh, selectedRole]);

  async function publishCatalog() {
    if (!isSystemAdmin) return;
    if (!(await appConfirm(
      "Publish the current system catalog as a read-only release?",
      { title: "Publish system catalog", kind: "warning", confirmLabel: "Publish catalog" },
    ))) return;
    setBusy("publish");
    setError("");
    try {
      const result = await invoke<{ currentReleaseVersion?: string }>("publish_portal_release", {
        updateMode: "system-db",
        releaseVersion: releaseVersion.trim() || null,
      });
      setReleaseVersion(result.currentReleaseVersion || releaseVersion);
      setNotice(`System catalog ${result.currentReleaseVersion || "release"} published.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  async function addUser() {
    const firstName = await promptText("First name");
    if (!firstName) return;
    const lastName = await promptText("Last name");
    if (!lastName) return;
    const email = await promptText("Work email");
    if (!email) return;
    const employeeId = await promptText("Employee ID");
    if (!employeeId) return;
    void runAction("user_create", { first_name: firstName, last_name: lastName, email, employee_id: employeeId }, "User created.");
  }

  async function editUser(row: UserRow) {
    const data: Record<string, unknown> = { id: row.id };
    const firstName = await promptText("First name", textValue(row.first_name, ""));
    if (firstName === null) return;
    const lastName = await promptText("Last name", textValue(row.last_name, ""));
    if (lastName === null) return;
    const email = await promptText("Work email", textValue(row.email, ""));
    if (email === null) return;
    data.first_name = firstName;
    data.last_name = lastName;
    data.email = email;
    void runAction("user_update", data, "User updated.");
  }

  async function setUserRole(row: UserRow) {
    const value = await promptText("Role: user, admin, or system_admin", truthy(row.is_system_admin) ? "system_admin" : truthy(row.is_admin) ? "admin" : "user");
    if (!value || !["user", "admin", "system_admin"].includes(value)) return;
    void runAction("user_set_role", { id: row.id, role: value }, "User role updated.");
  }

  async function addTeam() {
    const name = await promptText("Team name");
    if (!name) return;
    const description = await promptText("Description", "");
    if (description === null) return;
    void runAction("team_create", { name, description: description || null }, "Team created.");
  }

  async function editTeam(row: TeamRow) {
    const name = await promptText("Team name", row.name);
    if (!name) return;
    const description = await promptText("Description", textValue(row.description, ""));
    if (description === null) return;
    void runAction("team_update", { id: row.id, name, description: description || null }, "Team updated.");
  }

  async function editResource(row: ResourceRow) {
    const name = await promptText("Resource name", row.name);
    if (!name) return;
    const description = await promptText("Description", textValue(row.description, ""));
    if (description === null) return;
    void runAction("resource_update", { resource_id: row.resource_id || row.id, name, description: description || null }, "Resource updated.");
  }

  async function addPermission() {
    const resourceId = await promptText("Resource ID");
    if (!resourceId) return;
    const subjectType = await promptText("Subject type: team or user", "team");
    if (subjectType !== "team" && subjectType !== "user") return;
    const subjectId = await promptText(`${subjectType} ID`);
    if (!subjectId) return;
    const permission = await promptText("Permissions separated by commas (view, edit, manage, admin, review, create, delete)", "view");
    if (!permission) return;
    void runAction("permission_set", {
      resource_id: resourceId,
      team_id: subjectType === "team" ? subjectId : null,
      user_id: subjectType === "user" ? subjectId : null,
      permission_level: permission.split(",").map((item) => item.trim()).filter(Boolean),
    }, "Permission saved.");
  }

  async function addDictionaryItem(dictionary: DictionaryRow) {
    const label = await promptText("Dictionary value");
    if (!label) return;
    const code = await promptText("Code (optional)", "");
    if (code === null) return;
    const sortOrder = await promptNumber("Display order", String((dictionary.items || []).length + 1));
    void runAction("dictionary_item_upsert", { dictionary_id: dictionary.id, label, item_code: code, sort_order: sortOrder || 0 }, "Dictionary value saved.");
  }

  async function addHoliday() {
    const holidayName = await promptText("Holiday name");
    if (!holidayName) return;
    const holidayDate = await promptText("Holiday date (YYYY-MM-DD)");
    if (!holidayDate) return;
    void runAction("holiday_create", { holiday_name: holidayName, holiday_date: holidayDate, holiday_hours: 8, day_type: "Full day", is_active: true, reduces_weekly_target: true, extends_deadline: true }, "Holiday created.");
  }

  const visibleResources = useMemo(() => resources.filter((row) => {
    const needle = filter.toLowerCase();
    return !needle || [row.name, row.resource_id, row.resource_key, row.url, row.category].some((value) => String(value || "").toLowerCase().includes(needle));
  }), [filter, resources]);

  if (loading && !actor) {
    return <section className="manager-admin-loading"><RefreshCw className="spin" size={22} /><span>Loading local Portal administration...</span></section>;
  }

  if (error && !actor) {
    return <section className="manager-admin-loading manager-admin-error"><ShieldCheck size={24} /><h2>Administration unavailable</h2><p>{error}</p><button className="manager-admin-primary" onClick={() => window.location.reload()}>Retry</button></section>;
  }

  if (!canManage) {
    return <section className="manager-admin-loading manager-admin-error"><ShieldCheck size={24} /><h2>Administrator role required</h2><p>The selected Portal role cannot open the management catalog.</p></section>;
  }

  return (
    <section className="manager-admin-workspace">
      <div className="manager-admin-layout">
        <nav className="manager-admin-sidebar" aria-label="Portal administration">
          {NAVIGATION.map(({ id, label, icon: Icon }) => <button className={section === id ? "active" : ""} key={id} onClick={() => { setSection(id); setFilter(""); }}><Icon size={17} strokeWidth={1.8} /><span>{label}</span></button>)}
        </nav>

        <main className="manager-admin-content">
          {notice ? <div className="manager-admin-notice"><span>{notice}</span><button title="Dismiss" onClick={() => setNotice("")}><X size={15} /></button></div> : null}
          {error ? <div className="manager-admin-notice error"><span>{error}</span><button title="Dismiss" onClick={() => setError("")}><X size={15} /></button></div> : null}

          {section === "overview" ? (
            <>
              <div className="manager-admin-metrics">
                {([ ["Users", summary.users, Users], ["Teams", summary.teams, FolderTree], ["Resources", summary.resources, Database], ["Permissions", summary.permissions, KeyRound], ["Dictionaries", summary.dictionaries, BookOpen], ["Audit events", summary.audit_events, Activity] ] as Array<[string, number, LucideIcon]>).map(([label, value, Icon]) => <div className="manager-admin-metric" key={label}><Icon size={18} /><span>{label}</span><strong>{value}</strong></div>)}
              </div>
              <section className="manager-admin-panel manager-admin-overview-panel">
                <div className="manager-admin-panel-heading"><div><p className="eyebrow">SYSTEM CATALOG</p><h3>Administration is local and explicit</h3></div><Settings2 size={22} /></div>
                <p>Changes are written to the local system catalog through the Python management runner. Resource discovery remains the source of truth for application URLs; permissions and user preferences are maintained here.</p>
                <div className="manager-admin-publish-row"><label><span>Release version</span><input value={releaseVersion} placeholder="2026-218" onChange={(event) => setReleaseVersion(event.target.value)} /></label><button className="manager-admin-primary" disabled={!isSystemAdmin || busy === "publish"} onClick={() => void publishCatalog()}><Save size={15} />{busy === "publish" ? "Publishing..." : "Publish system catalog"}</button></div>
              </section>
            </>
          ) : null}

          {section === "users" ? (
            <section className="manager-admin-panel"><div className="manager-admin-panel-heading"><div><p className="eyebrow">ACCOUNTS</p><h3>{users.length} users</h3></div><ActionButton label="Add user" icon={UserPlus} onClick={addUser} /></div><AdminTable rows={users} columns={[
              { label: "Name", render: (row) => <strong>{textValue(`${row.first_name || ""} ${row.last_name || ""}`.trim())}</strong> },
              { label: "Email", render: (row) => textValue(row.email) },
              { label: "Employee ID", render: (row) => textValue(row.employee_id) },
              { label: "Team", render: (row) => textValue(row.team_name) },
              { label: "Role", render: (row) => displayRole(truthy(row.is_system_admin) ? "system_admin" : truthy(row.is_admin) ? "admin" : "user") },
              { label: "Status", render: (row) => <span className={`manager-admin-status ${truthy(row.is_active) ? "active" : "inactive"}`}>{truthy(row.is_active) ? "Active" : "Disabled"}</span> },
            ]} actions={(row) => <><ActionButton label="Edit" icon={Edit3} onClick={() => void editUser(row)} /><ActionButton label="Reset" icon={KeyRound} onClick={() => void runAction("user_reset", { id: row.id }, "Password reset to employee ID.")} /><ActionButton label="Role" icon={ShieldCheck} onClick={() => void setUserRole(row)} />{isSystemAdmin ? <ActionButton label="Delete" icon={Trash2} danger onClick={() => { void appConfirm(`Delete ${textValue(row.email)}?`, { title: "Delete user", kind: "danger", confirmLabel: "Delete" }).then((confirmed) => { if (confirmed) void runAction("user_delete", { id: row.id }, "User deleted."); }); }} /> : null}</>} /></section>
          ) : null}

          {section === "teams" ? (
            <section className="manager-admin-panel"><div className="manager-admin-panel-heading"><div><p className="eyebrow">ORGANIZATION</p><h3>{teams.length} teams</h3></div><ActionButton label="Add team" icon={UserPlus} onClick={addTeam} /></div><AdminTable rows={teams} columns={[
              { label: "Team", render: (row) => <strong>{row.name}</strong> },
              { label: "Parent", render: (row) => textValue(row.parent_name) },
              { label: "Manager", render: (row) => textValue(row.manager_name) },
              { label: "Members", render: (row) => textValue(row.member_count, "0") },
              { label: "Status", render: (row) => <span className={`manager-admin-status ${truthy(row.is_active) ? "active" : "inactive"}`}>{truthy(row.is_active) ? "Active" : "Disabled"}</span> },
            ]} actions={(row) => <><ActionButton label="Edit" icon={Edit3} onClick={() => void editTeam(row)} /><ActionButton label={truthy(row.is_active) ? "Disable" : "Enable"} onClick={() => void runAction("team_update", { id: row.id, is_active: !truthy(row.is_active) }, "Team status updated.")} />{isSystemAdmin ? <ActionButton label="Delete" icon={Trash2} danger onClick={() => { void appConfirm(`Delete ${row.name}?`, { title: "Delete team", kind: "danger", confirmLabel: "Delete" }).then((confirmed) => { if (confirmed) void runAction("team_delete", { id: row.id }, "Team deleted."); }); }} /> : null}</>} /></section>
          ) : null}

          {section === "resources" ? (
            <section className="manager-admin-panel"><div className="manager-admin-panel-heading"><div><p className="eyebrow">RESOURCE CATALOG</p><h3>{visibleResources.length} of {resources.length} resources</h3></div><label className="manager-admin-filter"><Search size={15} /><input value={filter} placeholder="Filter name, ID, URL" onChange={(event) => setFilter(event.target.value)} /></label></div><AdminTable rows={visibleResources} columns={[
              { label: "Resource", render: (row) => <strong>{row.name}</strong> },
              { label: "Resource ID", render: (row) => textValue(row.resource_id || row.resource_key) },
              { label: "Type", render: (row) => textValue(row.resource_type) },
              { label: "Category", render: (row) => textValue(row.category) },
              { label: "URL", render: (row) => <code>{textValue(row.url)}</code> },
              { label: "Access", render: (row) => truthy(row.is_public) ? "Public" : truthy(row.is_active) ? "Active" : "Inactive" },
            ]} actions={(row) => <><ActionButton label="Edit" icon={Edit3} onClick={() => void editResource(row)} /><ActionButton label={truthy(row.is_active) ? "Disable" : "Enable"} onClick={() => void runAction("resource_update", { resource_id: row.resource_id || row.id, is_active: !truthy(row.is_active) }, "Resource status updated.")} />{isSystemAdmin ? <ActionButton label="Delete" icon={Trash2} danger onClick={() => { void appConfirm(`Remove ${row.name} and its permissions?`, { title: "Remove resource", kind: "danger", confirmLabel: "Remove" }).then((confirmed) => { if (confirmed) void runAction("resource_delete", { resource_id: row.resource_id || row.id }, "Resource removed."); }); }} /> : null}</>} /></section>
          ) : null}

          {section === "permissions" ? (
            <section className="manager-admin-panel"><div className="manager-admin-panel-heading"><div><p className="eyebrow">ACCESS CONTROL</p><h3>{permissions.length} direct permissions</h3></div><ActionButton label="Add permission" icon={KeyRound} onClick={addPermission} /></div><AdminTable rows={permissions} columns={[
              { label: "Resource", render: (row) => <strong>{textValue(row.resource_name)}</strong> },
              { label: "Resource ID", render: (row) => textValue(row.resource_id || row.resource_key) },
              { label: "Subject", render: (row) => row.team_name ? `Team: ${row.team_name}` : `User: ${textValue(row.user_name)}` },
              { label: "Permissions", render: (row) => permissionText(row.permission_level) },
              { label: "URL", render: (row) => <code>{textValue(row.url)}</code> },
            ]} actions={(row) => isSystemAdmin ? <ActionButton label="Clear" icon={Trash2} danger onClick={() => { void appConfirm("Clear this direct permission?", { title: "Clear direct permission", kind: "danger", confirmLabel: "Clear permission" }).then((confirmed) => { if (confirmed) void runAction("permission_clear", { resource_id: row.resource_id || row.resource_record_id, team_id: row.team_id || null, user_id: row.user_id || null }, "Permission cleared."); }); }} /> : <span className="manager-admin-muted">System admin only</span>} /></section>
          ) : null}

          {section === "dictionaries" ? <section className="manager-admin-panel"><div className="manager-admin-panel-heading"><div><p className="eyebrow">CONTROLLED VALUES</p><h3>{dictionaries.length} dictionaries</h3></div><span className="manager-admin-muted">Changes are audited in the system catalog.</span></div><div className="manager-admin-dictionary-list">{dictionaries.map((dictionary) => <article className="manager-admin-dictionary" key={dictionary.id}><header><div><strong>{dictionary.name}</strong><code>{dictionary.dictionary_key}</code></div><ActionButton label="Add value" icon={UserPlus} onClick={() => void addDictionaryItem(dictionary)} /></header><AdminTable rows={dictionary.items || []} columns={[{ label: "Order", render: (row) => textValue(row.sort_order, "0") }, { label: "Code", render: (row) => textValue(row.item_code) }, { label: "Value", render: (row) => <strong>{row.label}</strong> }, { label: "Status", render: (row) => truthy(row.is_active) ? "Active" : "Disabled" }]} actions={(row) => <><ActionButton label={truthy(row.is_active) ? "Disable" : "Enable"} onClick={() => void runAction("dictionary_item_disable", { id: row.id }, "Dictionary value status updated.")} />{isSystemAdmin ? <ActionButton label="Delete" icon={Trash2} danger onClick={() => { void appConfirm(`Delete ${row.label}?`, { title: "Delete dictionary value", kind: "danger", confirmLabel: "Delete" }).then((confirmed) => { if (confirmed) void runAction("dictionary_item_delete", { id: row.id }, "Dictionary value deleted."); }); }} /> : null}</>} /></article>)}</div></section> : null}

          {section === "holidays" ? <section className="manager-admin-panel"><div className="manager-admin-panel-heading"><div><p className="eyebrow">WORK CALENDAR</p><h3>{holidays.length} holiday entries</h3></div><ActionButton label="Add holiday" icon={CalendarDays} onClick={() => void addHoliday()} /></div><AdminTable rows={holidays} columns={[{ label: "Holiday", render: (row) => <strong>{textValue(row.holiday_name)}</strong> }, { label: "Date", render: (row) => textValue(row.holiday_date || row.actual_date) }, { label: "Hours", render: (row) => textValue(row.holiday_hours, "0") }, { label: "Day type", render: (row) => textValue(row.day_type) }, { label: "Status", render: (row) => truthy(row.is_active) ? "Active" : "Disabled" }, { label: "Notes", render: (row) => textValue(row.notes) }]} actions={(row) => <><ActionButton label="Edit" icon={Edit3} onClick={() => { void promptText("Holiday name", textValue(row.holiday_name, "")).then((name) => { if (name) void runAction("holiday_update", { id: row.id, holiday_name: name }, "Holiday updated."); }); }} /><ActionButton label={truthy(row.is_active) ? "Disable" : "Enable"} onClick={() => void runAction("holiday_update", { id: row.id, is_active: !truthy(row.is_active) }, "Holiday status updated.")} />{isSystemAdmin ? <ActionButton label="Delete" icon={Trash2} danger onClick={() => { void appConfirm("Delete this holiday?", { title: "Delete holiday", kind: "danger", confirmLabel: "Delete" }).then((confirmed) => { if (confirmed) void runAction("holiday_delete", { id: row.id }, "Holiday deleted."); }); }} /> : null}</>} /></section> : null}

          {section === "audit" ? <section className="manager-admin-panel"><div className="manager-admin-panel-heading"><div><p className="eyebrow">AUDIT TRAIL</p><h3>{audit.length} recent events</h3></div><span className="manager-admin-muted">Most recent changes first.</span></div><AdminTable rows={audit} columns={[{ label: "Time", render: (row) => displayDate(row.created_at) }, { label: "User", render: (row) => textValue(row.actor_name || row.actor_email) }, { label: "Action", render: (row) => <strong>{textValue(row.action || row.event_type)}</strong> }, { label: "Entity", render: (row) => textValue(row.entity_type) }, { label: "ID", render: (row) => textValue(row.entity_id) }, { label: "Details", render: (row) => <code className="manager-admin-details">{textValue(row.details_json)}</code> }]} /></section> : null}
        </main>
      </div>
    </section>
  );
}
