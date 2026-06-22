import {
  useConsoleAccounts,
  useConsolePackages,
  useConsoleProcesses,
  useConsoleTargets,
} from "../hooks/useConsoleData";
import type { ConsoleResourceState } from "../domain/consoleModels";
import {
  ConsolePage,
  ConsoleResourceBoundary,
  ConsoleSection,
  rowsFromAccounts,
  rowsFromPackages,
  rowsFromProcesses,
  rowsFromTargets,
} from "../components/ConsolePageTemplate";

type ConsoleListKind = "crew" | "machines" | "library" | "tasks";

type ConsoleListPageProps = {
  kind: ConsoleListKind;
};

export function ConsoleListPage({ kind }: ConsoleListPageProps) {
  const accounts = useConsoleAccounts({ enabled: kind === "crew" });
  const targets = useConsoleTargets({ enabled: kind === "machines" });
  const packages = useConsolePackages({ enabled: kind === "library" });
  const processes = useConsoleProcesses({ enabled: kind === "tasks" });
  const title = kind === "crew"
    ? "CREW"
    : kind === "machines"
      ? "MACHINES"
      : kind === "library"
        ? "LIBRARY"
        : "TASKS";
  const emptyLabel = kind === "crew"
    ? "NO ACCOUNTS"
    : kind === "machines"
      ? "NO MACHINES"
      : kind === "library"
        ? "NO PACKAGES"
        : "NO TASKS";

  const resource: ConsoleResourceState<readonly unknown[]> = kind === "crew"
    ? accounts.resource
    : kind === "machines"
      ? targets.resource
      : kind === "library"
        ? packages.resource
        : processes.resource;

  const rows = kind === "crew"
    ? rowsFromAccounts(accounts.accounts)
    : kind === "machines"
      ? rowsFromTargets(targets.targets)
      : kind === "library"
        ? rowsFromPackages(packages.packages)
        : rowsFromProcesses(processes.processes);

  return (
    <ConsolePage>
      <ConsoleResourceBoundary
        resource={resource}
        emptyLabel={emptyLabel}
        errorLabel={title}
        render={() => (
          <ConsoleSection
            title={title}
            meta={`${rows.length}`}
            rows={rows}
            emptyLabel={emptyLabel}
          />
        )}
      />
    </ConsolePage>
  );
}
