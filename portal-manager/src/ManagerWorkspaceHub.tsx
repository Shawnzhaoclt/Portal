import { ArrowRight, ShieldCheck, Wrench } from "lucide-react";
import type { PortalUser } from "../../ui/src/management/api";

type WorkspaceStatus = {
  schedulerRunning: boolean;
  latestResult: string;
};

type ManagerWorkspaceHubProps = {
  user: PortalUser | null;
  status: WorkspaceStatus | null;
  onSelectMaintenance: () => void;
  onSelectAdministration: () => void;
};

function roleLabel(role?: PortalUser["selected_role"]) {
  if (role === "system_admin") return "System Admin";
  if (role === "admin") return "Portal Admin";
  return "Authorized Manager";
}

export default function ManagerWorkspaceHub({
  user,
  status,
  onSelectMaintenance,
  onSelectAdministration,
}: ManagerWorkspaceHubProps) {
  const maintenanceStatus = status
    ? status.schedulerRunning
      ? "Scheduler running"
      : `Last sync: ${status.latestResult || "No runs recorded"}`
    : "Checking maintenance status";

  return (
    <main className="workspace-hub">
      <header className="workspace-hub-header">
        <div>
          <p className="eyebrow">PORTAL WORKSTATION MANAGER</p>
          <h1>Choose a workspace</h1>
          <p>Use the workspace that matches the task you need to complete.</p>
        </div>
        <div className="workspace-hub-user">
          <strong>{user?.display_name ?? "Authorized user"}</strong>
          <span>{roleLabel(user?.selected_role)}</span>
        </div>
      </header>

      <section className="workspace-hub-content">
        <div className="workspace-hub-intro">
          <p className="eyebrow">WORKSPACE SELECTION</p>
          <h2>What would you like to manage?</h2>
          <p>Maintenance and Portal Administration are separate workspaces with independent navigation.</p>
        </div>

        <div className="workspace-choice-grid">
          <button className="workspace-choice-card" type="button" onClick={onSelectMaintenance}>
            <span className="workspace-choice-icon maintenance"><Wrench size={30} /></span>
            <span className="workspace-choice-copy">
              <strong>Maintenance</strong>
              <span>Run synchronization, inspect repositories, publish releases, manage schemas, and review maintenance activity.</span>
            </span>
            <span className="workspace-choice-footer">
              <span className="workspace-choice-status">{maintenanceStatus}</span>
              <ArrowRight size={20} />
            </span>
          </button>

          <button className="workspace-choice-card" type="button" onClick={onSelectAdministration}>
            <span className="workspace-choice-icon administration"><ShieldCheck size={30} /></span>
            <span className="workspace-choice-copy">
              <strong>Portal Administration</strong>
              <span>Manage users, teams, resources, permissions, holidays, dictionaries, audit logs, and the system catalog.</span>
            </span>
            <span className="workspace-choice-footer">
              <span className="workspace-choice-status">{roleLabel(user?.selected_role)} access granted</span>
              <ArrowRight size={20} />
            </span>
          </button>
        </div>

        <p className="workspace-hub-note">Your Windows account was verified before these workspaces became available.</p>
      </section>
    </main>
  );
}
