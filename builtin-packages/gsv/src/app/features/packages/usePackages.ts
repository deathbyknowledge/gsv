import { useEffect, useMemo, useState } from "preact/hooks";
import type { GsvBackend } from "../../backend-contract";
import {
  pushPackagesLocation,
  readPackageFromLocation,
  readPackagesViewFromLocation,
} from "../../navigation/route-state";
import { errorToText } from "../../utils/format";
import { filteredPackages } from "./packages-domain";
import type {
  AddCatalogRemoteArgs,
  CreatePackageArgs,
  CreatePackageResult,
  ImportPackageArgs,
  ImportPackageResult,
  PackageRecord,
  PackageScopeFilter,
  PackagesState,
  PackagesView,
  RemoveCatalogRemoteArgs,
  StartPackageReviewResult,
} from "./types";

export type PackagesRuntime = {
  state: PackagesState | null;
  loading: boolean;
  pendingAction: string | null;
  error: string | null;
  notice: string | null;
  view: PackagesView;
  scope: PackageScopeFilter;
  query: string;
  selectedPackageId: string | null;
  selectedPackage: PackageRecord | null;
  visiblePackages: PackageRecord[];
  setView(view: PackagesView): void;
  setScope(scope: PackageScopeFilter): void;
  setQuery(query: string): void;
  selectPackage(packageId: string | null): void;
  refresh(): Promise<void>;
  syncPackages(): Promise<void>;
  enablePackage(packageId: string): Promise<void>;
  disablePackage(packageId: string): Promise<void>;
  approvePackageReview(packageId: string): Promise<void>;
  refreshPackage(packageId: string): Promise<void>;
  pullPackage(packageId: string): Promise<void>;
  pullPackageSource(repo: string): Promise<void>;
  setPackagePublic(args: { packageId?: string; repo?: string; public: boolean }): Promise<void>;
  startPackageReview(packageId: string): Promise<StartPackageReviewResult | null>;
  importPackage(args: ImportPackageArgs): Promise<PackageRecord | null>;
  createPackage(args: CreatePackageArgs): Promise<CreatePackageResult | null>;
  addCatalogRemote(args: AddCatalogRemoteArgs): Promise<void>;
  removeCatalogRemote(args: RemoveCatalogRemoteArgs): Promise<void>;
};

export function usePackages(backend: GsvBackend): PackagesRuntime {
  const [state, setState] = useState<PackagesState | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setViewState] = useState<PackagesView>(readViewFromLocation);
  const [scope, setScopeState] = useState<PackageScopeFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(readPackageFromLocation);

  const selectedPackage = useMemo(
    () => state?.packages.find((pkg) => pkg.packageId === selectedPackageId) ?? null,
    [selectedPackageId, state],
  );

  const visiblePackages = useMemo(
    () => state ? filteredPackages(state, view, scope, query) : [],
    [query, scope, state, view],
  );

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const onPopState = () => {
      setViewState(readViewFromLocation());
      setSelectedPackageId(readPackageFromLocation());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  async function refresh(packageId = selectedPackageId ?? undefined): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const nextState = await backend.loadPackagesState({ packageId });
      setState(nextState);
    } catch (cause) {
      setError(errorToText(cause));
    } finally {
      setLoading(false);
    }
  }

  async function runMutation(action: string, task: () => Promise<void>): Promise<void> {
    setPendingAction(action);
    setError(null);
    setNotice(null);
    try {
      await task();
    } catch (cause) {
      setError(errorToText(cause));
    } finally {
      setPendingAction(null);
    }
  }

  async function syncPackages(): Promise<void> {
    await runMutation("packages:sync", async () => {
      await backend.syncPackages();
      setNotice("Synced packages from source.");
      await refresh();
    });
  }

  async function enablePackage(packageId: string): Promise<void> {
    await runMutation(`package:enable:${packageId}`, async () => {
      await backend.enablePackage({ packageId });
      setNotice("Package enabled.");
      await refresh(packageId);
    });
  }

  async function disablePackage(packageId: string): Promise<void> {
    await runMutation(`package:disable:${packageId}`, async () => {
      await backend.disablePackage({ packageId });
      setNotice("Package disabled.");
      await refresh(packageId);
    });
  }

  async function approvePackageReview(packageId: string): Promise<void> {
    await runMutation(`package:approve:${packageId}`, async () => {
      await backend.approvePackageReview({ packageId });
      setNotice("Package review approved.");
      await refresh(packageId);
    });
  }

  async function refreshPackage(packageId: string): Promise<void> {
    await runMutation(`package:refresh:${packageId}`, async () => {
      await backend.refreshPackage({ packageId });
      setNotice("Synced package from source.");
      await refresh(packageId);
    });
  }

  async function pullPackage(packageId: string): Promise<void> {
    await runMutation(`package:pull:${packageId}`, async () => {
      await backend.pullPackage({ packageId });
      setNotice("Pulled upstream changes. Sync the package to install them.");
      await refresh(packageId);
    });
  }

  async function pullPackageSource(repo: string): Promise<void> {
    await runMutation(`source:pull:${repo}`, async () => {
      await backend.pullPackageSource({ repo });
      setNotice(`Pulled upstream changes for ${repo}. Sync packages to install them.`);
      await refresh();
    });
  }

  async function setPackagePublic(args: { packageId?: string; repo?: string; public: boolean }): Promise<void> {
    await runMutation(`package:public:${args.packageId ?? args.repo ?? "unknown"}`, async () => {
      await backend.setPackagePublic(args);
      setNotice(args.public ? "Package source published." : "Package source made private.");
      await refresh(args.packageId ?? selectedPackageId ?? undefined);
    });
  }

  async function startPackageReview(packageId: string): Promise<StartPackageReviewResult | null> {
    let result: StartPackageReviewResult | null = null;
    await runMutation(`package:review:${packageId}`, async () => {
      result = await backend.startPackageReview({ packageId });
      setNotice("Opened package review in Chat.");
    });
    return result;
  }

  async function importPackage(args: ImportPackageArgs): Promise<PackageRecord | null> {
    let imported: PackageRecord | null = null;
    await runMutation("package:import", async () => {
      const result: ImportPackageResult = await backend.importPackage(args);
      imported = result.package;
      setNotice(`Imported ${result.package.name}.`);
      selectPackage(result.package.packageId);
      await refresh(result.package.packageId);
    });
    return imported;
  }

  async function createPackage(args: CreatePackageArgs): Promise<CreatePackageResult | null> {
    let created: CreatePackageResult | null = null;
    await runMutation("package:create", async () => {
      const result = await backend.createPackage(args);
      created = result;
      setNotice(`${result.created ? "Created" : "Updated"} ${result.package.name} with ${result.files.length} scaffold file${result.files.length === 1 ? "" : "s"}.`);
      selectPackage(result.package.packageId);
      await refresh(result.package.packageId);
    });
    return created;
  }

  async function addCatalogRemote(args: AddCatalogRemoteArgs): Promise<void> {
    await runMutation("catalog-remote:add", async () => {
      await backend.addCatalogRemote(args);
      setNotice(`Added remote ${args.name}.`);
      await refresh();
    });
  }

  async function removeCatalogRemote(args: RemoveCatalogRemoteArgs): Promise<void> {
    await runMutation(`catalog-remote:remove:${args.name}`, async () => {
      await backend.removeCatalogRemote(args);
      setNotice(`Removed remote ${args.name}.`);
      await refresh();
    });
  }

  function setView(nextView: PackagesView): void {
    setViewState(nextView);
    setSelectedPackageId(null);
    pushPackagesLocation({ view: nextView, packageId: null });
  }

  function setScope(nextScope: PackageScopeFilter): void {
    setScopeState(nextScope);
  }

  function selectPackage(packageId: string | null): void {
    setSelectedPackageId(packageId);
    pushPackagesLocation({ packageId, view });
    if (packageId) {
      void refresh(packageId);
    }
  }

  return {
    state,
    loading,
    pendingAction,
    error,
    notice,
    view,
    scope,
    query,
    selectedPackageId,
    selectedPackage,
    visiblePackages,
    setView,
    setScope,
    setQuery,
    selectPackage,
    refresh,
    syncPackages,
    enablePackage,
    disablePackage,
    approvePackageReview,
    refreshPackage,
    pullPackage,
    pullPackageSource,
    setPackagePublic,
    startPackageReview,
    importPackage,
    createPackage,
    addCatalogRemote,
    removeCatalogRemote,
  };
}

const readViewFromLocation = readPackagesViewFromLocation;
