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
      onPublishSystemCatalog={async (environment) => {
        const isTest = environment === "test";
        const confirmed = await appConfirm(
          isTest
            ? "Publish the current system catalog to the TEST data tree? Production desktops will not see it; only machines pointed at the test data root activate it."
            : "Publish the current authoritative system catalog as Portal data? Desktop clients will encrypt it with SQLCipher during local activation.",
          {
            title: isTest ? "Publish catalog to TEST" : "Publish system catalog",
            kind: "warning",
            confirmLabel: isTest ? "Publish to test" : "Publish catalog",
          },
        );
        if (!confirmed) return;
        const result = await invoke<{
          message?: string;
          publication?: { central_publication_id?: string; source_count?: number };
        }>("publish_system_catalog_data", { environment });
        const publicationId = result.publication?.central_publication_id;
        const suffix = isTest
          ? "Only test-data desktops will activate it."
          : "Desktop clients will activate encrypted copies.";
        return publicationId
          ? `System catalog published${isTest ? " to TEST" : ""} in data manifest ${publicationId}. ${suffix}`
          : `System catalog published${isTest ? " to TEST" : ""}. ${suffix}`;
      }}
    />
  );
}
