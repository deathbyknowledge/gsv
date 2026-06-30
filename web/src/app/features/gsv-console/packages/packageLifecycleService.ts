import type { GSVClient } from "@humansandmachines/gsv/client";
import type { PkgSummary, ProcSpawnResult } from "@humansandmachines/gsv/protocol";
import { normalizePackagesPayload } from "../domain/consoleNormalization";
import type { ConsolePackage } from "../domain/consoleModels";
import {
  buildPackageReviewAssignmentContext,
  buildPackageReviewPrompt,
  mergeReviewPackageContext,
  normalizePackageImportDraft,
  parsePackageImportSource,
  packageSourcePathForPackage,
  type PackageImportDraft,
  type PackageReviewProcess,
} from "./packageImportFlow";

type PackageLifecycleClient = Pick<GSVClient, "pkg" | "proc">;

export async function importConsolePackage(
  client: Pick<PackageLifecycleClient, "pkg">,
  draft: PackageImportDraft,
): Promise<ConsolePackage> {
  const input = normalizePackageImportDraft(draft);
  const result = await client.pkg.add({
    ...parsePackageImportSource(input.source),
    ref: input.ref,
    subdir: input.subdir,
    enable: false,
  });

  return normalizeConsolePackageResult(result.package);
}

export async function startConsolePackageReview(
  client: Pick<PackageLifecycleClient, "proc">,
  input: {
    package: ConsolePackage;
    packages: readonly ConsolePackage[];
    reviewerUsername?: string;
  },
): Promise<PackageReviewProcess> {
  const packages = mergeReviewPackageContext(input.packages, input.package);
  const spawned = await client.proc.spawn({
    label: `Review ${input.package.name}`,
    ...(input.reviewerUsername ? { runAs: input.reviewerUsername } : {}),
    interactive: true,
    cwd: packageSourcePathForPackage(input.package, packages),
    prompt: buildPackageReviewPrompt(input.package, packages),
    assignment: {
      contextFiles: [{
        name: "20-package-review.md",
        text: buildPackageReviewAssignmentContext(input.package, packages),
      }],
    },
  });

  return normalizeSpawnResult(spawned);
}

export async function approveAndEnableConsolePackage(
  client: Pick<PackageLifecycleClient, "pkg">,
  pkg: ConsolePackage,
): Promise<ConsolePackage> {
  let current = pkg;
  if (pkg.reviewRequired && pkg.reviewApprovedAt === null) {
    const approved = await client.pkg.review.approve({ packageId: pkg.packageId });
    current = normalizeConsolePackageResult(approved.package);
  }

  const installed = await client.pkg.install({ packageId: current.packageId });
  return normalizeConsolePackageResult(installed.package);
}

export async function syncConsolePackage(
  client: Pick<PackageLifecycleClient, "pkg">,
  pkg: ConsolePackage,
): Promise<ConsolePackage> {
  const result = await client.pkg.sync({ packageId: pkg.packageId });
  return normalizeConsolePackageFromList(result.packages, pkg.packageId);
}

export async function checkoutConsolePackage(
  client: Pick<PackageLifecycleClient, "pkg">,
  input: { package: ConsolePackage; ref: string },
): Promise<ConsolePackage> {
  const ref = input.ref.trim();
  if (!ref) {
    throw new Error("source ref is required");
  }
  const result = await client.pkg.checkout({
    packageId: input.package.packageId,
    ref,
  });
  return normalizeConsolePackageResult(result.package);
}

export async function removeConsolePackage(
  client: Pick<PackageLifecycleClient, "pkg">,
  pkg: ConsolePackage,
): Promise<ConsolePackage> {
  const result = await client.pkg.remove({ packageId: pkg.packageId });
  return normalizeConsolePackageResult(result.package);
}

function normalizeConsolePackageResult(pkg: PkgSummary): ConsolePackage {
  const packages = normalizePackagesPayload({ packages: [pkg] });
  const normalized = packages[0];
  if (!normalized) {
    throw new Error("Package request did not return a package.");
  }
  return normalized;
}

function normalizeConsolePackageFromList(packages: readonly PkgSummary[], packageId: string): ConsolePackage {
  const normalized = normalizePackagesPayload({ packages });
  const pkg = normalized.find((entry) => entry.packageId === packageId) ?? normalized[0];
  if (!pkg) {
    throw new Error("Package request did not return a package.");
  }
  return pkg;
}

function normalizeSpawnResult(result: ProcSpawnResult): PackageReviewProcess {
  if (!result.ok) {
    throw new Error(result.error || "Failed to spawn review process.");
  }
  return {
    pid: result.pid,
    cwd: result.cwd || null,
  };
}
