import type { ComponentChildren } from "preact";
import "./Collapsible.css";

export interface CollapsibleProps {
  /** Unique id used to pair the hidden toggle with its label. */
  id: string;
  /** Panel-width breakpoint below which the body collapses to a drawer:
   *  "tablet" (<= 900px) or "mobile" (<= 560px). Above it the body always
   *  shows and the header keeps its normal (navigating) behavior.
   *
   *  Breakpoints are container queries against a `panel` container — render
   *  inside an ancestor with `container-name: panel`. */
  collapseAt: "tablet" | "mobile";
  className?: string;
  header: ComponentChildren;
  footer?: ComponentChildren;
  children: ComponentChildren;
}

/** Collapsible — a header that, below its `collapseAt` breakpoint, collapses its
 *  body to a click-to-expand drawer. Driven by a hidden checkbox + an overlay
 *  <label> (rather than <details>) so the expanded state is controlled entirely
 *  by our own CSS with no UA content-visibility quirks, and any nav button in
 *  the header never nests inside an interactive element. The overlay only
 *  appears in the collapsed range, so above the breakpoint the header behaves
 *  normally. */
export function Collapsible({ id, collapseAt, className = "", header, footer, children }: CollapsibleProps) {
  const toggleId = `gsv-collapse-${id}`;
  return (
    <div class={`gsv-collapse ${className}`.trim()} data-collapse={collapseAt}>
      <input type="checkbox" id={toggleId} class="gsv-collapse-toggle" hidden />
      <div class="gsv-collapse-summary">
        {header}
        <label class="gsv-collapse-toggle-label" for={toggleId} aria-label="Expand or collapse section">
          <span class="gsv-collapse-chevron" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M4 2.5 L8 6 L4 9.5" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="square" />
            </svg>
          </span>
        </label>
      </div>
      <div class="gsv-collapse-body">
        {children}
        {footer}
      </div>
    </div>
  );
}
