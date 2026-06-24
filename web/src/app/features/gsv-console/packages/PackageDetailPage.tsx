import { ConsoleDetailPage } from "../components/ConsoleDetailPage";
import type { PackageListKind } from "../domain/consoleListTypes";
import type { ConsolePackage } from "../domain/consoleModels";
import {
  launchableAppIdForPackage,
  packageDetailSections,
  packageListNoun,
  packageListTitle,
  packageSub,
  statusForPackage,
  toneForPackage,
} from "./packagePresentation";

type PackageDetailPageProps = {
  kind: PackageListKind;
  onBack: () => void;
  onOpenApp?: (appId: string, title?: string) => void;
  pkg: ConsolePackage;
};

export function PackageDetailPage({
  kind,
  onBack,
  onOpenApp,
  pkg,
}: PackageDetailPageProps) {
  const noun = packageListNoun(kind);
  const appId = launchableAppIdForPackage(pkg);

  return (
    <ConsoleDetailPage
      icon={pkg.uiEntrypoints.length > 0 ? "stars" : "pencil"}
      title={pkg.name}
      typeLabel={`GSV · ${noun}`}
      statusLabel={statusForPackage(pkg)}
      tone={toneForPackage(pkg)}
      blurb={pkg.description || packageSub(pkg)}
      parentLabel={packageListTitle(kind)}
      primaryLabel={appId && onOpenApp ? "OPEN APP" : undefined}
      onPrimary={appId && onOpenApp ? () => onOpenApp(appId, pkg.name) : undefined}
      sections={packageDetailSections(pkg)}
      onBack={onBack}
    />
  );
}
