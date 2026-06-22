import "./AddAction.css";

export type AddActionVariant = "row" | "tile";

export interface AddActionProps {
  variant?: AddActionVariant;
  label?: string;
  onClick?: () => void;
}

const PlusGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">
    <g fill="currentColor">
      <rect x="7" y="3" width="2" height="10" />
      <rect x="3" y="7" width="10" height="2" />
    </g>
  </svg>
);

/** AddAction — ported from AddAction.dc.html. Dashed "add new" affordance in two
 *  variants: a full-width row (with hover + chevron) and a stacked tile. */
export function AddAction({ variant = "row", label, onClick }: AddActionProps) {
  const text = label ?? (variant === "tile" ? "NEW AGENT" : "CONNECT NEW MACHINE");

  return (
    <div style={{ fontFamily: "var(--gsv-font-mono)" }}>
      {variant === "row" ? (
        <div
          onClick={onClick}
          class="aa"
          style={{
            border: "1px solid var(--border)",
            background: "var(--panel)",
            display: "flex",
            alignItems: "center",
            gap: "11px",
            padding: "13px 16px",
            cursor: "pointer",
            transition: "background .12s",
          }}
        >
          <span style={{ display: "flex", color: "var(--accent)" }}>
            <PlusGlyph />
          </span>
          <span style={{ fontSize: "11px", letterSpacing: ".04em", color: "var(--text-title)" }}>{text}</span>
          <span style={{ marginLeft: "auto" }}>
            <svg width="9" height="12" viewBox="0 0 9 12" style={{ display: "block", filter: "drop-shadow(0 0 3px rgba(150,140,255,.5))" }}>
              <path d="M0 0 L9 6 L0 12 Z" fill="var(--accent)" />
            </svg>
          </span>
        </div>
      ) : (
        <div
          onClick={onClick}
          style={{
            display: "inline-flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "9px",
            padding: "18px 26px",
            border: "1px dashed var(--dashed)",
            background: "var(--panel)",
            cursor: "pointer",
          }}
        >
          <div
            style={{
              width: "30px",
              height: "30px",
              border: "1px dashed var(--dashed)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--accent)",
            }}
          >
            <PlusGlyph />
          </div>
          <div style={{ fontSize: "10px", letterSpacing: ".06em", color: "var(--text-title)" }}>{text}</div>
        </div>
      )}
    </div>
  );
}
