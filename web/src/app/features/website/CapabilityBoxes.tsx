import { FIND_LABELS } from "./beats";

export interface CapabilityBoxesProps {
  /** Only animate once the beat is on screen, so the reveal isn't spent
   *  off-screen before anyone sees it. */
  active: boolean;
}

/** CapabilityBoxes — the "I can also find anything else…" beat. Labelled boxes
 *  settle into a grid one after another, each one a thing the agent surfaced.
 *  Staggering is done with a per-item CSS custom property rather than JS timers
 *  so the whole thing costs one class toggle. */
export function CapabilityBoxes({ active }: CapabilityBoxesProps) {
  return (
    <div class={`gsv-site-boxes${active ? " is-live" : ""}`} aria-hidden="true">
      {FIND_LABELS.map((label, i) => (
        <span
          class="gsv-site-box gsv-sublabel"
          key={label}
          style={{ "--i": String(i) } as Record<string, string>}
        >
          {label}
        </span>
      ))}
    </div>
  );
}
