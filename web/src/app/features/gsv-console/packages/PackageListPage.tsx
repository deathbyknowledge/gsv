import { useMemo, useState } from "preact/hooks";
import { ListTemplate } from "../list-template/ListTemplate";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import {
  NEW_DETAIL_ID,
  type ConsoleListSelection,
  type PackageListKind,
} from "../domain/consoleListTypes";
import type { ConsolePackage, ConsoleResourceState } from "../domain/consoleModels";
import {
  NATIVE_APP_ENTRIES,
  type NativeAppSurfaceId,
} from "../../gsv-shell/domain/shellModel";
import { useConsolePackages } from "../hooks/useConsoleData";
import { useConsoleListSelection } from "../hooks/useConsoleListSelection";
import { ApplicationImportFlow } from "./ApplicationImportFlow";
import { PackageDetailPage } from "./PackageDetailPage";
import {
  filterPackagesForKind,
  iconForPackage,
  packageListNoun,
  packageListTitle,
  packageSub,
  statusForPackage,
  toneForPackage,
} from "./packagePresentation";

type PackageListPageProps = {
  initialCreate?: boolean;
  initialDetailId?: string | null;
  initialDetailLabel?: string | null;
  kind: PackageListKind;
  onOpenApp?: (appId: string, title?: string) => void;
  /** Opens a native app surface (FILES, LIBRARY, TERMINAL, REPOS row click). */
  onOpenSurface?: (surface: NativeAppSurfaceId) => void;
  onSelectionChange?: (selection: ConsoleListSelection | null) => void;
};

function resourceWithLocalEmptyState<T>(resource: ConsoleResourceState<T>): ConsoleResourceState<T> {
  return { ...resource, isEmpty: false };
}

function packageErrorLabel(kind: PackageListKind): string {
  return "APPLICATIONS";
}

function PackageConsoleSection({
  kind,
  onOpenCreate,
  onOpenDetail,
  onOpenSurface,
  packages,
  refreshing,
}: {
  kind: PackageListKind;
  onOpenCreate?: () => void;
  onOpenDetail: (pkg: ConsolePackage) => void;
  onOpenSurface?: (surface: NativeAppSurfaceId) => void;
  packages: readonly ConsolePackage[];
  refreshing: boolean;
}) {
  // NOTE: Applications uses the shared (table) LIST template for now. This is a
  // placeholder — Applications is slated to move to the CARD template (an
  // application-card grid) in a future pass. See list-template/ListTemplate.
  const [query, setQuery] = useState("");
  const title = packageListTitle(kind);
  const noun = packageListNoun(kind);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Native GSV apps lead the list, unlabeled; the count in the header stays
    // a package count (natives are surfaces, not packages).
    const nativeRows = kind === "applications"
      ? NATIVE_APP_ENTRIES
          .filter((entry) => !q || entry.label.toLowerCase().includes(q))
          .map((entry) => ({
            id: `native:${entry.surface}`,
            icon: entry.icon,
            label: entry.label,
            sub: entry.blurb,
            tone: "online" as const,
            statusLabel: "SYSTEM",
            onOpen: onOpenSurface ? () => onOpenSurface(entry.surface) : undefined,
          }))
      : [];
    // Imported packages carry the EXTERNAL marker (a pending review keeps the
    // tag slot — that state is actionable) and PUBLIC/PRIVATE provenance in
    // the sub line.
    const packageRows = packages
      .filter((pkg) => !q || pkg.name.toLowerCase().includes(q))
      .map((pkg) => ({
        id: pkg.packageId,
        icon: iconForPackage(pkg, kind),
        label: pkg.name,
        sub: `${packageSub(pkg)} · ${pkg.sourcePublic ? "PUBLIC" : "PRIVATE"}`,
        tone: toneForPackage(pkg),
        statusLabel: statusForPackage(pkg),
        tag: pkg.reviewPending
          ? { label: "UPDATE", tone: "update" as const }
          : { label: "EXTERNAL", tone: "info" as const },
        onOpen: () => onOpenDetail(pkg),
      }));
    return [...nativeRows, ...packageRows];
  }, [packages, query, kind, onOpenDetail, onOpenSurface]);

  return (
    <ListTemplate
      listTitle={title}
      listMeta={refreshing ? "REFRESHING" : `${packages.length} ${noun}${packages.length === 1 ? "" : "S"}`}
      emptyObject={`${noun}S`}
      rows={rows}
      connectLabel={`+ CONNECT NEW ${noun}`}
      onConnect={onOpenCreate}
      search={{ value: query, placeholder: `Search ${noun.toLowerCase()}s…`, onChange: setQuery }}
    />
  );
}

function renderPackageDetail(
  packages: readonly ConsolePackage[],
  kind: PackageListKind,
  id: string,
  onBack: () => void,
  onOpenApp: ((appId: string, title?: string) => void) | undefined,
) {
  const pkg = packages.find((entry) => entry.packageId === id);
  return pkg ? <PackageDetailPage kind={kind} pkg={pkg} onBack={onBack} onOpenApp={onOpenApp} /> : null;
}

export function PackageListPage({
  initialCreate = false,
  initialDetailId = null,
  initialDetailLabel = null,
  kind,
  onOpenApp,
  onOpenSurface,
  onSelectionChange,
}: PackageListPageProps) {
  const packages = useConsolePackages({ enabled: true });
  const { selectedDetail, selectDetail } = useConsoleListSelection({
    initialCreate,
    initialDetailId,
    initialDetailLabel,
    kind,
    onSelectionChange,
  });

  return (
    <ConsolePage flush>
      <ConsoleResourceBoundary
        resource={resourceWithLocalEmptyState(packages.resource)}
        emptyLabel={`NO ${packageListNoun(kind)}S`}
        errorLabel={packageErrorLabel(kind)}
        render={(data) => {
          const scopedPackages = filterPackagesForKind(data, kind);

          if (selectedDetail?.kind === kind) {
            if (selectedDetail.createNew && kind === "applications") {
              return (
                <ApplicationImportFlow
                  packages={data}
                  onBack={() => selectDetail(null)}
                  onOpenPackage={(pkg) => selectDetail({ kind, id: pkg.packageId, label: pkg.name })}
                />
              );
            }

            const detail = renderPackageDetail(scopedPackages, kind, selectedDetail.id, () => selectDetail(null), onOpenApp);
            if (detail) {
              return detail;
            }
          }

          return (
            <PackageConsoleSection
              kind={kind}
              onOpenCreate={kind === "applications"
                ? () => selectDetail({ kind, id: NEW_DETAIL_ID, createNew: true })
                : undefined}
              onOpenDetail={(pkg) => selectDetail({ kind, id: pkg.packageId, label: pkg.name })}
              onOpenSurface={onOpenSurface}
              packages={scopedPackages}
              refreshing={packages.resource.isRefreshing}
            />
          );
        }}
      />
    </ConsolePage>
  );
}
