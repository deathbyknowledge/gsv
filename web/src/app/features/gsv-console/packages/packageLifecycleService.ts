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
    prompt: buildPackageReviewPrompt(input.package, packages),
    assignment: {
      contextFiles: [{
        name: "20-package-review.md",
        text: buildPackageReviewAssignmentContext(input.package, packages),
      }],
    },
    mounts: [
      { kind: "package-source", packageId: input.package.packageId },
    ],
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

function normalizeConsolePackageResult(pkg: PkgSummary): ConsolePackage {
  const packages = normalizePackagesPayload({ packages: [pkg] });
  const normalized = packages[0];
  if (!normalized) {
    throw new Error("Package request did not return a package.");
  }
  return normalized;
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
