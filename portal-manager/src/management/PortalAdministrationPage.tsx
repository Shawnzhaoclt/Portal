import ManagementPage from "../../../ui/src/management/ManagementPage";

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
    />
  );
}
