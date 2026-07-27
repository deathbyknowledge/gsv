import type { StatusTone } from "../../../components/ui/StatusDot";
import type { ConsoleAccount, ConsolePackage } from "../domain/consoleModels";

export type ApplicationImportStep = "import" | "review";

export type PackageImportDraft = {
  source: string;
  ref: string;
  subdir: string;
  includeReview: boolean;
  reviewerUsername: string;
};

export type PackageImportSource =
  | { remoteUrl: string; repo?: never }
  | { repo: string; remoteUrl?: never };

export type PackageReviewProcess = {
  pid: string;
  cwd: string | null;
};

export const APPLICATION_IMPORT_STEP_LABELS = ["IMPORT", "REVIEW"] as const;

export function defaultPackageImportDraft(): PackageImportDraft {
  return {
    source: "",
    ref: "main",
    subdir: ".",
    includeReview: true,
    reviewerUsername: "",
  };
}

export function applicationImportStepIndex(step: ApplicationImportStep): number {
  return step === "review" ? 1 : 0;
}

export function normalizePackageImportDraft(draft: PackageImportDraft): PackageImportDraft {
  return {
    source: draft.source.trim(),
    ref: draft.ref.trim() || "main",
    subdir: draft.subdir.trim() || ".",
    includeReview: draft.includeReview,
    reviewerUsername: draft.reviewerUsername.trim(),
  };
}

export function isPackageImportDraftReady(draft: PackageImportDraft): boolean {
  return normalizePackageImportDraft(draft).source.length > 0;
}

export function isEligibleApplicationReviewer(account: ConsoleAccount): boolean {
  return account.runnable
    && (account.relation === "personal-agent" || account.relation === "agent");
}

export function parsePackageImportSource(raw: string): PackageImportSource {
  const source = raw.trim();
  if (!source) {
    throw new Error("Source is required.");
  }
  if (source.includes("://") || source.startsWith("git@")) {
    return { remoteUrl: source };
  }
  return { repo: source.replace(/^\/+|\/+$/g, "") };
}

export function isConsoleApplicationPackage(pkg: ConsolePackage): boolean {
  return pkg.runtime === "web-ui"
    || pkg.uiEntrypoints.length > 0
    || pkg.entrypoints.some((entrypoint) => entrypoint.kind === "ui");
}

export function packageRuntimeLabel(runtime: ConsolePackage["runtime"]): string {
  if (runtime === "dynamic-worker") return "DYNAMIC WORKER";
  if (runtime === "web-ui") return "WEB UI";
  if (runtime === "node") return "NODE";
  return "UNKNOWN RUNTIME";
}

export function packageSourceSummary(pkg: ConsolePackage): string {
  return [
    pkg.sourceRepo,
    pkg.sourceRef ? `ref ${pkg.sourceRef}` : "",
    pkg.sourceSubdir && pkg.sourceSubdir !== "." ? pkg.sourceSubdir : "",
  ].filter(Boolean).join(" / ") || pkg.packageId;
}

export function packageReviewLabel(pkg: ConsolePackage): string {
  if (!pkg.reviewRequired) return "NOT REQUIRED";
  if (pkg.reviewApprovedAt !== null) return "APPROVED";
  return "REQUIRED";
}

export function packageStatusLabel(pkg: ConsolePackage): string {
  if (pkg.reviewPending) return "REVIEW";
  if (pkg.enabled) return "ENABLED";
  return "DISABLED";
}

export function packageStatusTone(pkg: ConsolePackage): StatusTone {
  if (pkg.reviewPending) return "update";
  if (pkg.enabled) return "online";
  return "idle";
}

export function packageCapabilitySummary(pkg: ConsolePackage): string {
  const parts = [
    packageRuntimeLabel(pkg.runtime),
    pkg.entrypoints.length > 0 ? `${pkg.entrypoints.length} entrypoint${pkg.entrypoints.length === 1 ? "" : "s"}` : "",
    pkg.profiles.length > 0 ? `${pkg.profiles.length} service profile${pkg.profiles.length === 1 ? "" : "s"}` : "",
    pkg.bindingNames.length > 0 ? `${pkg.bindingNames.length} binding${pkg.bindingNames.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.join(" / ") || "PACKAGE";
}

export function mergeReviewPackageContext(
  packages: readonly ConsolePackage[],
  target: ConsolePackage,
): ConsolePackage[] {
  const withoutTarget = packages.filter((pkg) => packageSourceRecordKey(pkg) !== packageSourceRecordKey(target));
  return [...withoutTarget, target];
}

export function buildPackageReviewPrompt(pkg: ConsolePackage, packages: readonly ConsolePackage[]): string {
  const bindings = pkg.bindingNames.length > 0 ? pkg.bindingNames.join(", ") : "none declared";
  const entrypoints = pkg.entrypoints.length > 0
    ? pkg.entrypoints.map((entrypoint) => `${entrypoint.name}:${entrypoint.kind}`).join(", ")
    : "none";
  const profiles = pkg.profiles.length > 0
    ? pkg.profiles.map((profile) => `${profile.account.runAs || profile.name} -> ${profile.account.username || "account pending"}`).join(", ")
    : "none";
  const sourcePath = packageSourcePathForPackage(pkg, packages);

  return [
    `Review the imported package "${pkg.name}".`,
    "",
    `Current directory is already ${sourcePath}.`,
    `The package source is available at ${sourcePath}.`,
    "Source writes are staged in the review process. Use rgit status --here and rgit diff --here to inspect staged changes; do not commit unless explicitly asked.",
    "",
    `Source repo: ${pkg.sourceRepo || "unknown"}`,
    `Source ref: ${pkg.sourceRef || "main"}`,
    `Subdir: ${pkg.sourceSubdir || "."}`,
    `Declared bindings: ${bindings}`,
    `Entrypoints: ${entrypoints}`,
    `Service profiles: ${profiles}`,
    "",
    "Review workflow:",
    "1. Start with pkg manifest, pkg capabilities, pkg source, rgit refs --here, and rgit log --here.",
    `2. Inspect ${sourcePath}, prioritizing manifest, entrypoints, and system integration points.`,
    "3. Search for network access, parent-window messaging, host bridge use, process spawning, filesystem writes, shell execution, eval, and destructive actions.",
    "4. If a command fails, note it briefly and continue with other evidence. Do not guess.",
    "5. Keep tool use tight. Do not narrate trivial navigation or run placeholder commands.",
    "",
    "Use normal filesystem and shell exploration plus the pkg CLI.",
    "Helpful commands: ls, find, grep, cat, pkg manifest, pkg capabilities, pkg source, rgit refs --here, rgit log --here, rgit status --here, rgit diff --here.",
    "Focus on requested capabilities, suspicious behavior, hidden network or shell access, destructive actions, and whether it should be enabled.",
    "Call out privileged integrations explicitly, including host bridge access, parent-window messaging, and process spawning if present.",
    "Conclude with a short verdict: approve or do not approve, followed by a concise evidence-based summary.",
  ].join("\n");
}

export function buildPackageReviewAssignmentContext(pkg: ConsolePackage, packages: readonly ConsolePackage[]): string {
  const sourcePath = packageSourcePathForPackage(pkg, packages);
  return [
    "# Package Review",
    "",
    `You are reviewing the imported package "${pkg.name}".`,
    `The package source is available at ${sourcePath}, and the process starts there.`,
    "",
    "Treat this as a focused code review for whether the package should be enabled.",
    "Prioritize manifest, entrypoints, declared capabilities, host bridge usage, filesystem writes, shell execution, process spawning, network access, eval, and destructive actions.",
    "Keep evidence concrete. If a command fails, note it briefly and continue with other review evidence.",
    "Do not approve the package unless the reviewed source and requested capabilities match the user's intent.",
  ].join("\n");
}

export function packageSourcePathForPackage(pkg: ConsolePackage, _packages: readonly ConsolePackage[]): string {
  const repo = normalizeSourcePathPart(pkg.sourceRepo);
  const subdir = normalizeSourcePathPart(pkg.sourceSubdir);
  const root = `/src/repos/${repo}`;
  return subdir && subdir !== "." ? `${root}/${subdir}` : root;
}

function normalizeSourcePathPart(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
}

function packageSourceRecordKey(pkg: ConsolePackage): string {
  if (pkg.scopeKind === "user") {
    return `user:${pkg.scopeUid ?? ""}:${pkg.packageId}`;
  }
  if (pkg.scopeKind === "global") {
    return `global:${pkg.packageId}`;
  }
  return `${pkg.scopeKind}:${pkg.packageId}`;
}
