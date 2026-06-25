import { ConsoleDetailPage } from "../components/ConsoleDetailPage";
import type { PackageListKind } from "../domain/consoleListTypes";

type PackageCreatePlaceholderPageProps = {
  kind: Exclude<PackageListKind, "library">;
  onBack: () => void;
};

export function PackageCreatePlaceholderPage({
  onBack,
}: PackageCreatePlaceholderPageProps) {
  const noun = "APPLICATION";
  return (
    <ConsoleDetailPage
      icon="stars"
      title={`NEW ${noun}`}
      typeLabel={`GSV · ${noun}`}
      statusLabel="NOT CONFIGURED"
      tone="idle"
      blurb="Awaiting source selection and access configuration."
      parentLabel="APPLICATIONS"
      pendingLabel="FORM PLACEHOLDER"
      primaryLabel={`CREATE ${noun}`}
      onBack={onBack}
    />
  );
}
