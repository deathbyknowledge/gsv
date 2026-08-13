import type { JSX } from "preact";
import "../textClient.css";

export interface MomentRailItem {
  id: string;
  label: string;
  detail?: string;
  disabled?: boolean;
}

export interface MomentRailProps {
  items: readonly MomentRailItem[];
  currentId: string | null;
  onSelect: (id: string) => void;
  ariaLabel?: string;
  className?: string;
  onWheel?: (event: JSX.TargetedWheelEvent<HTMLElement>) => void;
}

/** A compact, chronological navigation rail for moving between saved moments. */
export function MomentRail({
  items,
  currentId,
  onSelect,
  ariaLabel = "Moments",
  className,
  onWheel,
}: MomentRailProps) {
  const classes = ["text-client-moment-rail", className].filter(Boolean).join(" ");

  return (
    <nav class={classes} aria-label={ariaLabel} onWheel={onWheel}>
      <ol class="text-client-moment-list">
        {items.map((item) => {
          const isCurrent = item.id === currentId;

          return (
            <li
              key={item.id}
              class={`text-client-moment${isCurrent ? " is-current" : ""}`}
            >
              <button
                type="button"
                class="text-client-moment-button"
                aria-current={isCurrent ? "step" : undefined}
                disabled={item.disabled}
                onClick={() => onSelect(item.id)}
              >
                <span class="text-client-moment-marker" aria-hidden="true" />
                <span class="text-client-moment-copy text-client-visually-hidden">
                  <span class="text-client-moment-label">{item.label}</span>
                  {item.detail ? (
                    <span class="text-client-moment-detail">{item.detail}</span>
                  ) : null}
                </span>
                {isCurrent ? (
                  <span class="text-client-visually-hidden">Current moment</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
