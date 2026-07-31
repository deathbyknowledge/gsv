import { Collapsible } from "./Collapsible";
import "./DataCard.css";

export interface DataCardRow {
  id?: string;
  /** Field label (e.g. "CHAT MODEL"). Rendered with a trailing ":". */
  label: string;
  /** Primary value / item name (e.g. "GLM5"). */
  value: string;
  /** Optional description — rendered parenthesised on its own line. */
  description?: string;
  /** Optional trailing CTA ("manage", "edit files"…), revealed on card hover. */
  linkLabel?: string;
  /** Render the CTA as an "opens elsewhere" affordance — a floating new-tab
   *  glyph after the label — instead of the in-app ">" chevron. */
  linkExternal?: boolean;
  onLink?: () => void;
}

export interface DataCardProps {
  title: string;
  rows: readonly DataCardRow[];
  /** Text-color variant — every element (title, label, value, description, CTA)
   *  takes this one color. */
  variant?: "white" | "yellow";
  /** Collapse to a click-to-expand drawer below the given breakpoint. */
  collapse?: { id: string; at: "tablet" | "mobile" };
  className?: string;
}

/** DataCard — the "data display card": a terminal "screen" holding a title over
 *  rows of `LABEL: value` / (description) / CTA. All text is one size and one
 *  color (only the title is larger); the two variants recolor everything white
 *  or yellow. CTAs stay hidden until the card is hovered/focused. Optionally
 *  collapses to a drawer on narrow panels (the title is the toggle). */
export function DataCard({ title, rows, variant = "white", collapse, className = "" }: DataCardProps) {
  const header = <div class="gsv-dc-title">{title}</div>;

  const body = (
    <div class="gsv-dc-body">
      {rows.map((row, index) => (
        <div class="gsv-dc-row" key={row.id ?? row.label ?? index}>
          <p class="gsv-dc-label">{row.label}:</p>
          <p class="gsv-dc-value">{row.value}</p>
          {row.description ? <p class="gsv-dc-desc">({row.description})</p> : null}
          {row.linkLabel ? (
            <button type="button" class="gsv-dc-link" onClick={row.onLink} disabled={!row.onLink}>
              <span class="gsv-dc-link-label">{row.linkLabel}</span>
              {row.linkExternal ? (
                <svg class="gsv-dc-link-newtab" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true">
                  <path d="M8 3 L3 3 L3 13 L13 13 L13 8" />
                  <path d="M9 7 L13 3" />
                  <path d="M9.5 3 L13 3 L13 6.5" />
                </svg>
              ) : (
                <span class="gsv-dc-link-arrow" aria-hidden="true">&gt;</span>
              )}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );

  const rootClass = `gsv-dc gsv-dc--${variant} ${className}`.trim();

  if (collapse) {
    return (
      <Collapsible id={collapse.id} collapseAt={collapse.at} className={rootClass} header={header}>
        {body}
      </Collapsible>
    );
  }

  return (
    <div class={rootClass}>
      {header}
      {body}
    </div>
  );
}
