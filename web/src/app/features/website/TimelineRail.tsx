import { BEATS } from "./beats";

export interface TimelineRailProps {
  /** Index of the beat currently on screen. */
  current: number;
  /** Shown only once the opening screen is behind us. */
  visible: boolean;
  /** Jump to a beat. */
  onSelect: (index: number) => void;
}

/** TimelineRail — the conversation's spatial timeline, one marker per moment.
 *
 *  Ported from the desktop app's `render_timeline` (host/apps/desktop/src/app/
 *  view.rs): 4×8px pill markers in 20px slots, the selected one in accent at
 *  full strength and the rest quieted to 0.68. The desktop app anchors this on
 *  the left; here it sits on the right, per the brief. */
export function TimelineRail({ current, visible, onSelect }: TimelineRailProps) {
  return (
    <nav
      class={`gsv-site-rail${visible ? " is-shown" : ""}`}
      aria-label="Conversation timeline"
      aria-hidden={visible ? undefined : "true"}
    >
      {BEATS.map((beat, index) => {
        const selected = index === current;
        return (
          <button
            type="button"
            key={beat.id}
            class={`gsv-site-rail-slot${selected ? " is-selected" : ""}`}
            aria-label={`Go to message ${index + 1}`}
            aria-current={selected ? "step" : undefined}
            tabIndex={visible ? 0 : -1}
            onClick={() => onSelect(index)}
          >
            <span class="gsv-site-rail-mark" aria-hidden="true" />
          </button>
        );
      })}
    </nav>
  );
}
