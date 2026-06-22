import {
  ConsolePage,
  ConsoleResourceBoundary,
  ConsoleSection,
  type ConsoleRow,
} from "../../gsv-console/components/ConsolePageTemplate";
import { useTerminalTargets } from "../hooks/useTerminalQueries";

export function TerminalSurfaceSummary() {
  const targets = useTerminalTargets();
  const rows: ConsoleRow[] = targets.targets.map((target) => ({
    id: target.id,
    icon: "computer",
    label: target.label,
    sub: [target.platform, target.description].filter(Boolean).join(" · "),
    tone: target.online ? "online" : "idle",
    statusLabel: target.online ? "ONLINE" : "OFFLINE",
  }));

  return (
    <ConsolePage>
      <ConsoleResourceBoundary
        resource={targets.resource}
        emptyLabel="NO COMMAND TARGETS"
        errorLabel="TERMINAL"
        render={() => (
          <ConsoleSection title="COMMAND TARGETS" meta={`${rows.length}`} rows={rows} emptyLabel="NO TARGETS" />
        )}
      />
    </ConsolePage>
  );
}
