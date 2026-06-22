import {
  ConsolePage,
  ConsoleResourceBoundary,
  ConsoleSection,
  type ConsoleRow,
} from "../../gsv-console/components/ConsolePageTemplate";
import { useFilesTargets } from "../hooks/useFilesQueries";

export function FilesSurfaceSummary() {
  const targets = useFilesTargets();
  const rows: ConsoleRow[] = targets.targets.map((target) => ({
    id: target.id,
    icon: "computer",
    label: target.label,
    sub: [target.platform, target.ownerUsername, target.description].filter(Boolean).join(" · "),
    tone: target.online ? "online" : "idle",
    statusLabel: target.online ? "ONLINE" : "OFFLINE",
  }));

  return (
    <ConsolePage>
      <ConsoleResourceBoundary
        resource={targets.resource}
        emptyLabel="NO FILE TARGETS"
        errorLabel="FILES"
        render={() => (
          <ConsoleSection title="FILE TARGETS" meta={`${rows.length}`} rows={rows} emptyLabel="NO TARGETS" />
        )}
      />
    </ConsolePage>
  );
}
