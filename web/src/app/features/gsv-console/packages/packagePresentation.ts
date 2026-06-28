import { OBJECT_GLYPH_ICON } from "../../../components/ui/objectGlyph";
import type { StatusTone } from "../../../components/ui/StatusDot";
import { isNativeWebPackageName } from "../../packages/nativePackages";
import {
  detailRow,
  listRowStatusForTone,
  liveRows,
} from "../components/consoleDetailRows";
import type { ConsoleDetailSection } from "../components/ConsoleDetailPage";
import { compactText, formatAge } from "../domain/consoleFormat";
import type { PackageListKind } from "../domain/consoleListTypes";
import type { ConsolePackage } from "../domain/consoleModels";

export function iconForPackage(pkg: ConsolePackage, kind: PackageListKind): string {
  // Applications use the shared object-level icon (single source of truth) so
  // the list rows always match the desktop tile / nav rail / object card.
  if (isApplicationPackage(pkg)) return OBJECT_GLYPH_ICON.applications;
  if (pkg.runtime === "web-ui") return "stars";
  if (pkg.runtime === "node") return "terminal";
  return "pencil";
}

export function filterPackagesForKind(packages: readonly ConsolePackage[], kind: PackageListKind): ConsolePackage[] {
  const visiblePackages = packages.filter((pkg) => !isNativeConsolePackage(pkg));
  return visiblePackages.filter(isApplicationPackage);
}

export function isApplicationPackage(pkg: ConsolePackage): boolean {
  return pkg.runtime === "web-ui" || pkg.uiEntrypoints.length > 0 || pkg.entrypoints.some((entrypoint) => entrypoint.kind === "ui");
}

function isNativeConsolePackage(pkg: ConsolePackage): boolean {
  return isNativeWebPackageName(pkg.name) || isNativeWebPackageName(pkg.packageId);
}

export function packageListTitle(kind: PackageListKind): string {
  return "APPLICATIONS";
}

export function packageListNoun(kind: PackageListKind): string {
  return "APPLICATION";
}

export function toneForPackage(pkg: ConsolePackage): StatusTone {
  if (pkg.reviewPending) return "update";
  if (pkg.enabled) return "online";
  return "idle";
}

export function statusForPackage(pkg: ConsolePackage): string {
  if (pkg.reviewPending) return "REVIEW";
  if (pkg.enabled) return "ENABLED";
  return "DISABLED";
}

export function packageSub(pkg: ConsolePackage): string {
  return compactText([
    pkg.version ? `v${pkg.version}` : "",
    runtimeLabel(pkg.runtime),
    pkg.sourceRepo,
    pkg.sourceRef,
  ], pkg.packageId);
}

export function runtimeLabel(runtime: ConsolePackage["runtime"]): string {
  if (runtime === "dynamic-worker") return "DYNAMIC WORKER";
  if (runtime === "web-ui") return "WEB UI";
  if (runtime === "node") return "NODE";
  return "UNKNOWN RUNTIME";
}

export function launchableAppIdForPackage(pkg: ConsolePackage): string | null {
  const uiEntrypoints = pkg.uiEntrypoints.filter((entrypoint) => entrypoint.route.trim().length > 0);
  if (pkg.runtime !== "web-ui" || !pkg.enabled || uiEntrypoints.length === 0) {
    return null;
  }
  return uiEntrypoints.length === 1 ? pkg.name : `${pkg.name}-${uiEntrypoints[0].name}`;
}

export function packageDetailSections(pkg: ConsolePackage): ConsoleDetailSection[] {
  return [
    {
      title: "PACKAGE",
      meta: statusForPackage(pkg),
      rows: liveRows([
        detailRow("package-id", "PACKAGE ID", pkg.packageId),
        detailRow("status", "STATUS", statusForPackage(pkg), {
          status: listRowStatusForTone(toneForPackage(pkg)),
          statusLabel: statusForPackage(pkg),
        }),
        detailRow("runtime", "RUNTIME", runtimeLabel(pkg.runtime)),
        detailRow("version", "VERSION", pkg.version),
        detailRow("scope", "SCOPE", pkg.scopeKind === "user" && pkg.scopeUid !== null ? `USER ${pkg.scopeUid}` : pkg.scopeKind.toUpperCase()),
        detailRow("review", "REVIEW REQUIRED", pkg.reviewRequired),
      ]),
    },
    {
      title: "SOURCE",
      meta: pkg.sourcePublic ? "PUBLIC" : "PRIVATE",
      rows: liveRows([
        detailRow("repo", "REPOSITORY", pkg.sourceRepo),
        detailRow("ref", "REF", pkg.sourceRef),
        detailRow("subdir", "SUBDIRECTORY", pkg.sourceSubdir),
        detailRow("installed", "INSTALLED", pkg.installedAt === null ? "" : formatAge(pkg.installedAt)),
        detailRow("updated", "UPDATED", pkg.updatedAt === null ? "" : formatAge(pkg.updatedAt)),
      ]),
    },
    {
      title: "ENTRYPOINTS",
      meta: `${pkg.entrypoints.length}`,
      rows: liveRows([
        detailRow("ui-entrypoints", "UI", pkg.uiEntrypoints.map((entrypoint) => entrypoint.name).join(" / ")),
        detailRow("entrypoints", "ALL", pkg.entrypoints.map((entrypoint) => entrypoint.name).join(" / ")),
        detailRow("bindings", "BINDINGS", pkg.bindingNames.join(" / ")),
      ]),
    },
  ];
}
