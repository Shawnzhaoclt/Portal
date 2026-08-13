import { invoke } from "@tauri-apps/api/core";
import ManagementPage from "../../../ui/src/management/ManagementPage";
import { appConfirm } from "../messageDialogService";

type PortalAdministrationPageProps = {
  onBack: () => void;
};

export default function PortalAdministrationPage({ onBack }: PortalAdministrationPageProps) {
  return (
    <ManagementPage
      backLabel="Back to Manager"
      onBack={onBack}
      redirectOnMissingToken={false}
      showBackAction
      showRoleSelector
      showSignOutAction={false}
      showSystemCatalogPublication
      onPublishSystemCatalog={async () => {
        const confirmed = await appConfirm(
          "Publish the current authoritative system catalog as a read-only Portal data version?",
          { title: "Publish system catalog", kind: "warning", confirmLabel: "Publish catalog" },
        );
        if (!confirmed) return;
        const result = await invoke<{
          publication?: { central_publication_id?: string; source_count?: number };
        }>("publish_system_catalog_data");
        const publicationId = result.publication?.central_publication_id;
        return publicationId
          ? `Read-only system catalog published in data manifest ${publicationId}.`
          : "Read-only system catalog published.";
      }}
    />
  );
}
