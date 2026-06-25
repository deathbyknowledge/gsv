import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import { useConsoleOverview } from "../hooks/useConsoleData";
import {
  SettingsOverviewDashboard,
  type OpenAgent,
  type OpenListCreate,
  type OpenListDetail,
  type OpenSurface,
} from "./ConsoleOverviewPanels";
import "./ConsoleOverviewPage.css";

export type { ConsoleOverviewTarget } from "./ConsoleOverviewPanels";

export function ConsoleOverviewPage({
  onOpenAgent,
  onOpenListCreate,
  onOpenListDetail,
  onOpenSurface,
}: {
  onOpenAgent?: OpenAgent;
  onOpenListCreate?: OpenListCreate;
  onOpenListDetail?: OpenListDetail;
  onOpenSurface?: OpenSurface;
}) {
  const overview = useConsoleOverview();

  return (
    <ConsolePage flush>
      <ConsoleResourceBoundary
        resource={overview.resource}
        emptyLabel="NO CONSOLE DATA"
        errorLabel="CONSOLE OVERVIEW"
        render={(data) => (
          <SettingsOverviewDashboard
            counts={overview.counts}
            data={data}
            onOpenAgent={onOpenAgent}
            onOpenListCreate={onOpenListCreate}
            onOpenListDetail={onOpenListDetail}
            onOpenSurface={onOpenSurface}
          />
        )}
      />
    </ConsolePage>
  );
}
