import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { packageAppsQueryKey } from "../../packages/usePackageApps";
import {
  consoleOverviewQueryKey,
  consolePackagesQueryKey,
  consoleProcessesQueryKey,
} from "../hooks/useConsoleData";
import type { ConsolePackage } from "../domain/consoleModels";
import {
  approveAndEnableConsolePackage,
  importConsolePackage,
  startConsolePackageReview,
} from "./packageLifecycleService";
import {
  defaultPackageImportDraft,
  normalizePackageImportDraft,
  type ApplicationImportStep,
  type PackageImportDraft,
  type PackageReviewProcess,
} from "./packageImportFlow";

type UsePackageImportFlowOptions = {
  knownPackages: readonly ConsolePackage[];
};

export function usePackageImportFlow({ knownPackages }: UsePackageImportFlowOptions) {
  const { client } = useGateway();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<PackageImportDraft>(defaultPackageImportDraft);
  const [step, setStep] = useState<ApplicationImportStep>("import");
  const [importedPackage, setImportedPackage] = useState<ConsolePackage | null>(null);
  const [reviewProcess, setReviewProcess] = useState<PackageReviewProcess | null>(null);

  const importMutation = useMutation<ConsolePackage, Error, PackageImportDraft>({
    mutationFn: (nextDraft) => importConsolePackage(client, nextDraft),
    onSuccess: async (pkg) => {
      setImportedPackage(pkg);
      setStep("review");
      await invalidatePackageData(queryClient);
    },
  });

  const reviewMutation = useMutation<PackageReviewProcess, Error, {
    package: ConsolePackage;
    reviewerUsername: string;
  }>({
    mutationFn: (input) => startConsolePackageReview(client, {
      package: input.package,
      packages: knownPackages,
      reviewerUsername: input.reviewerUsername,
    }),
    onSuccess: async (process) => {
      setReviewProcess(process);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: consoleProcessesQueryKey }),
        queryClient.invalidateQueries({ queryKey: ["processes"] }),
      ]);
    },
  });

  const enableMutation = useMutation<ConsolePackage, Error, ConsolePackage>({
    mutationFn: (pkg) => approveAndEnableConsolePackage(client, pkg),
    onSuccess: async (pkg) => {
      setImportedPackage(pkg);
      await invalidatePackageData(queryClient);
    },
  });

  const updateDraft = (patch: Partial<PackageImportDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const importApplication = async () => {
    const normalized = normalizePackageImportDraft(draft);
    const pkg = await importMutation.mutateAsync(normalized);
    if (normalized.includeReview) {
      await reviewMutation.mutateAsync({
        package: pkg,
        reviewerUsername: normalized.reviewerUsername,
      });
    }
    return pkg;
  };

  const startReview = async () => {
    if (!importedPackage) {
      return null;
    }
    const process = await reviewMutation.mutateAsync({
      package: importedPackage,
      reviewerUsername: normalizePackageImportDraft(draft).reviewerUsername,
    });
    return process;
  };

  const enableImportedPackage = async () => {
    if (!importedPackage) {
      return null;
    }
    return await enableMutation.mutateAsync(importedPackage);
  };

  // Block importing the exact same source again (repo + ref + subdir) — that
  // package already exists. Different subdirs/refs of the same repo are distinct
  // packages, so compare the full triple. The gateway stays authoritative.
  const normalizedDraft = normalizePackageImportDraft(draft);
  const duplicateSource =
    normalizedDraft.source.length > 0 &&
    knownPackages.some((pkg) =>
      pkg.sourceRepo.trim().toLowerCase() === normalizedDraft.source.toLowerCase() &&
      pkg.sourceRef.trim().toLowerCase() === normalizedDraft.ref.toLowerCase() &&
      pkg.sourceSubdir.trim().toLowerCase() === normalizedDraft.subdir.toLowerCase());

  return {
    draft,
    duplicateSource,
    enableImportedPackage,
    enableMutation,
    importApplication,
    importedPackage,
    importMutation,
    reviewMutation,
    reviewProcess,
    setStep,
    startReview,
    step,
    updateDraft,
  };
}

async function invalidatePackageData(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: consolePackagesQueryKey }),
    queryClient.invalidateQueries({ queryKey: consoleOverviewQueryKey }),
    queryClient.invalidateQueries({ queryKey: packageAppsQueryKey }),
    queryClient.invalidateQueries({ queryKey: ["packages"] }),
  ]);
}
