import type { ContextState } from "../../types";
import { GaugeIcon } from "../../icons";
import { formatContextPressure } from "../../view-helpers";

export function ContextMeter({ state }: { state: ContextState | null }) {
  if (!state) {
    return null;
  }
  const pressure = state.pressure === null ? 0 : Math.max(0, Math.min(1, state.pressure));
  const text = formatContextPressure(state);
  return (
    <div class={`context-meter is-${state.level}`} title={`${text} - ${state.source === "provider" ? "provider usage" : "estimated"}`}>
      <GaugeIcon />
      <span class="context-track"><span style={{ width: `${Math.round(pressure * 100)}%` }} /></span>
      <span>{text}</span>
    </div>
  );
}
