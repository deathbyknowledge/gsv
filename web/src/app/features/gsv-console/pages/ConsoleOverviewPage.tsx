import { useConsoleOverview } from "../hooks/useConsoleData";
import {
  ConsoleOverviewSections,
  ConsoleOverviewStats,
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";

export function ConsoleOverviewPage() {
  const overview = useConsoleOverview();

  return (
    <ConsolePage>
      <ConsoleResourceBoundary
        resource={overview.resource}
        emptyLabel="NO CONSOLE DATA"
        errorLabel="CONSOLE OVERVIEW"
        render={(data) => (
          <>
            <ConsoleOverviewStats counts={overview.counts} refreshing={overview.resource.isRefreshing} />
            <ConsoleOverviewSections overview={data} />
          </>
        )}
      />
    </ConsolePage>
  );
}
