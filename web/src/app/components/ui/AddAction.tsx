import type { JSX } from "preact";
import "./AddAction.css";

export type AddActionVariant = "row" | "tile";

export interface AddActionProps {
  variant?: AddActionVariant;
  label?: string;
  /** Tile width in px. Omitted → fills its container (the object strip sets it). */
  width?: number;
  onClick?: () => void;
}

const PlusGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">
    <g fill="currentColor">
      <rect x="7" y="3" width="2" height="10" />
      <rect x="3" y="7" width="10" height="2" />
    </g>
  </svg>
);

/** AddAction — ported from AddAction.dc.html. Dashed "add new" affordance in two
 *  variants: a full-width row (with hover + chevron) and a stacked tile. */
export function AddAction({ variant = "row", label, width, onClick }: AddActionProps) {
  const text = label ?? (variant === "tile" ? "NEW AGENT" : "CONNECT NEW MACHINE");
  const rowStyle: JSX.CSSProperties = {
    width: "100%",
    appearance: "none",
    border: "1px solid var(--border)",
    background: "var(--panel)",
    boxSizing: "border-box",
    color: "inherit",
    display: "flex",
    alignItems: "center",
    gap: "11px",
    minHeight: "44px",
    padding: "13px 16px",
    cursor: onClick ? "pointer" : "default",
    font: "inherit",
    fontFamily: "var(--gsv-font-mono)",
    textAlign: "left",
    transition: "background .12s",
  };
  // Tile mirrors the ObjectCard head: a dashed "+" box on the left, label inline,
  // sized to match the object cards (the strip stretches it to the grid cell).
  const tileStyle: JSX.CSSProperties = {
    appearance: "none",
    boxSizing: "border-box",
    ...(width != null ? { width: `${width}px` } : {}),
    border: "1px dashed var(--dashed)",
    background: "var(--panel)",
    color: "inherit",
    display: "flex",
    alignItems: "center",
    gap: "11px",
    padding: "12px 13px",
    cursor: onClick ? "pointer" : "default",
    font: "inherit",
    fontFamily: "var(--gsv-font-mono)",
    textAlign: "left",
    transition: "background .12s, border-color .12s",
  };
  const rowContent = (
    <>
      <span style={{ display: "flex", color: "var(--accent)" }}>
        <PlusGlyph />
      </span>
      <span style={{ fontSize: "11px", letterSpacing: ".04em", color: "var(--text-title)" }}>{text}</span>
      <span style={{ marginLeft: "auto" }}>
        <svg width="9" height="12" viewBox="0 0 9 12" aria-hidden="true" style={{ display: "block", filter: "drop-shadow(0 0 3px rgba(150,140,255,.5))" }}>
          <path d="M0 0 L9 6 L0 12 Z" fill="var(--accent)" />
        </svg>
      </span>
    </>
  );
  const tileContent = (
    <>
      <span
        style={{
          flex: "none",
          width: "26px",
          height: "26px",
          border: "1px dashed var(--dashed)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--accent)",
        }}
      >
        <PlusGlyph />
      </span>
      <span style={{ fontSize: "11px", letterSpacing: ".06em", color: "var(--text-title)" }}>{text}</span>
    </>
  );

  const action = variant === "row"
    ? onClick
      ? <button type="button" class="aa" data-clickable="true" style={rowStyle} onClick={onClick}>{rowContent}</button>
      : <div class="aa" style={rowStyle}>{rowContent}</div>
    : onClick
      ? <button type="button" class="aa" data-clickable="true" style={tileStyle} onClick={onClick}>{tileContent}</button>
      : <div class="aa" style={tileStyle}>{tileContent}</div>;

  return (
    <div style={{ fontFamily: "var(--gsv-font-mono)" }}>
      {action}
    </div>
  );
}
