import { AsciiPlanet } from "../../../components/ui/AsciiPlanet";
import { DesktopHint } from "../../gsv-shell/desktop/DesktopHint";
import "./TemplateEmptyState.css";

/** Shared empty state for the list/card templates: a full-bleed ship-style
 *  banner (AsciiPlanet placeholder) over a "NO <OBJECT>" label rendered with the
 *  amber desktop terminal lettering (DesktopHint). */
export function TemplateEmptyState({ object }: { object: string }) {
  const label = `NO ${object}`;
  return (
    <div class="gsv-template-empty">
      <div class="gsv-template-empty-banner">
        <AsciiPlanet variant="moon" formDuration={3.4} label={label} />
      </div>
      <div class="gsv-template-empty-hint">
        <DesktopHint lines={[`> ${label}`]} minimizedText={label} />
      </div>
    </div>
  );
}
