import { ConsoleDetailPage } from "../components/ConsoleDetailPage";
import type { PackageListKind } from "../domain/consoleListTypes";

type PackageCreatePlaceholderPageProps = {
  kind: Exclude<PackageListKind, "library">;
  onBack: () => void;
};

export function PackageCreatePlaceholderPage({
  kind,
  onBack,
}: PackageCreatePlaceholderPageProps) {
  const noun = kind === "integrations" ? "INTEGRATION" : "APPLICATION";
  return (
    <ConsoleDetailPage
      icon={kind === "integrations" ? "weblink" : "stars"}
      title={`NEW ${noun}`}
      typeLabel={`GSV · ${noun}`}
      statusLabel="NOT CONFIGURED"
      tone="idle"
      blurb="Awaiting source selection and access configuration."
      parentLabel={kind === "integrations" ? "INTEGRATIONS" : "APPLICATIONS"}
      pendingLabel="FORM PLACEHOLDER"
      primaryLabel={`CREATE ${noun}`}
      onBack={onBack}
    />
  );
}
