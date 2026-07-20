import type { ComponentChildren, JSX } from "preact";
import "./wireframe.css";

/** Schematic wireframe primitives — rectangles-only, no real content. Used by the
 *  Templates stories to sketch each archetype's page structure (header / nav /
 *  toolbar / content / action regions) as labeled boxes before the live preview.
 *  Deliberately minimal and tuned to the catalog's dark, mono aesthetic. */

function toDim(value: number | string | undefined): string | undefined {
  if (value == null) return undefined;
  return typeof value === "number" ? `${value}px` : value;
}

/** Outer page frame — a bordered void-backed schematic. */
export function Wire({
  children,
  ratio,
}: {
  children: ComponentChildren;
  /** Optional aspect label shown for context, e.g. "console page". */
  ratio?: string;
}) {
  return (
    <div class="ds-wire">
      {ratio ? <div class="ds-wire-ratio">{ratio}</div> : null}
      <div class="ds-wire-canvas">{children}</div>
    </div>
  );
}

/** Horizontal band of regions. */
export function WireRow({
  children,
  gap = 8,
  align = "stretch",
  wrap = false,
}: {
  children: ComponentChildren;
  gap?: number;
  align?: JSX.CSSProperties["alignItems"];
  wrap?: boolean;
}) {
  return (
    <div
      class="ds-wire-row"
      style={{ gap: `${gap}px`, alignItems: align, flexWrap: wrap ? "wrap" : "nowrap" }}
    >
      {children}
    </div>
  );
}

/** Vertical stack of regions — use inside a WireRow for a column area. */
export function WireCol({
  children,
  gap = 8,
  grow,
  w,
}: {
  children: ComponentChildren;
  gap?: number;
  grow?: number;
  w?: number | string;
}) {
  const style: JSX.CSSProperties = { gap: `${gap}px` };
  if (w != null) {
    style.flex = "none";
    style.width = toDim(w);
  } else {
    style.flex = `${grow ?? 1} 1 0`;
  }
  return (
    <div class="ds-wire-col" style={style}>
      {children}
    </div>
  );
}

/** A single labeled rectangle region. Splits its row evenly by default; pass `w`
 *  for a fixed width or `grow` to bias the flex ratio. `tone` accents the box. */
export function WireBox({
  label,
  h = 44,
  grow,
  w,
  tone,
}: {
  label?: string;
  h?: number | string;
  grow?: number;
  w?: number | string;
  tone?: "accent" | "muted" | "dashed";
}) {
  const style: JSX.CSSProperties = { height: toDim(h) };
  if (w != null) {
    style.flex = "none";
    style.width = toDim(w);
  } else {
    style.flex = `${grow ?? 1} 1 0`;
  }
  return (
    <div class={`ds-wire-box${tone ? ` is-${tone}` : ""}`} style={style}>
      {label ? <span class="ds-wire-label">{label}</span> : null}
    </div>
  );
}

/** Repeated rows placeholder (list bodies, card grids). */
export function WireRepeat({
  count = 3,
  h = 34,
  gap = 6,
  tone,
  label,
}: {
  count?: number;
  h?: number;
  gap?: number;
  tone?: "accent" | "muted" | "dashed";
  label?: string;
}) {
  return (
    <div class="ds-wire-col" style={{ gap: `${gap}px` }}>
      {Array.from({ length: count }, (_, i) => (
        <WireBox key={i} h={h} tone={tone} label={i === 0 ? label : undefined} />
      ))}
    </div>
  );
}

/** "LIVE PREVIEW ↗" link — opens the real component preview in a new tab at
 *  /design/preview/<id>. Styled in wireframe.css. */
export function PreviewLink({ id, label = "LIVE PREVIEW" }: { id: string; label?: string }) {
  return (
    <a class="ds-btn-preview" href={`/design/preview/${id}`} target="_blank" rel="noopener">
      {label}
      <span class="ds-btn-preview-arrow" aria-hidden="true">↗</span>
    </a>
  );
}

/** Grid of placeholder cards. */
export function WireGrid({
  count = 4,
  h = 96,
  min = 120,
  gap = 8,
}: {
  count?: number;
  h?: number;
  min?: number;
  gap?: number;
}) {
  return (
    <div
      class="ds-wire-grid"
      style={{ gap: `${gap}px`, gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}
    >
      {Array.from({ length: count }, (_, i) => (
        <WireBox key={i} h={h} tone="muted" />
      ))}
    </div>
  );
}
