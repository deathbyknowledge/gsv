import { ConsoleHeader } from "../../../components/ui/ConsoleHeader";
import { FilesSurfaceSummary } from "../../files/components/FilesSurfaceSummary";
import { TerminalSurfaceSummary } from "../../terminal/components/TerminalSurfaceSummary";
import { shellSurfaceLabel, type ShellSurfaceId } from "../../gsv-shell/domain/shellModel";
import { ConsoleListPage } from "../pages/ConsoleListPage";
import { ConsoleOverviewPage } from "../pages/ConsoleOverviewPage";
import { ConsolePlaceholderPage } from "../pages/ConsolePlaceholderPage";

type GsvConsoleProps = {
  activeSurface: Exclude<ShellSurfaceId, "desktop">;
  onBackToDesktop: () => void;
};

function surfaceTail(surface: ShellSurfaceId): string {
  if (surface === "files") {
    return "GSV · STORAGE";
  }
  if (surface === "library") {
    return "GSV · PACKAGES";
  }
  if (surface === "terminal") {
    return "GSV · CONSOLE";
  }
  if (surface === "crew" || surface === "agent") {
    return "GSV · CREW";
  }
  return "GSV · CONTROL";
}

export function GsvConsole({
  activeSurface,
  onBackToDesktop,
}: GsvConsoleProps) {
  return (
    <section class="gsv-console-frame" aria-label={`${shellSurfaceLabel(activeSurface)} surface`}>
      <ConsoleHeader
        crumbs={[
          { label: "GSV", onClick: onBackToDesktop, notLast: true },
          { label: shellSurfaceLabel(activeSurface) },
        ]}
        tail={surfaceTail(activeSurface)}
        onBack={onBackToDesktop}
      />
      <div class="gsv-console-stage">
        {activeSurface === "settings" ? (
          <ConsoleOverviewPage />
        ) : activeSurface === "crew" ? (
          <ConsoleListPage kind="crew" />
        ) : activeSurface === "machines" ? (
          <ConsoleListPage kind="machines" />
        ) : activeSurface === "library" ? (
          <ConsoleListPage kind="library" />
        ) : activeSurface === "files" ? (
          <FilesSurfaceSummary />
        ) : activeSurface === "terminal" ? (
          <TerminalSurfaceSummary />
        ) : (
          <ConsolePlaceholderPage surface={activeSurface} />
        )}
      </div>
    </section>
  );
}
