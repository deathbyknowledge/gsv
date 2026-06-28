import type { ComponentChildren } from "preact";
import type { JSX } from "preact";
import { Icon } from "./Icon";
import "./ObjectCard.css";

export type ObjectCardGlyph = "machines" | "messengers" | "integrations" | "applications";
export type ObjectCardStatus = "online" | "error" | "idle" | "warn" | "live";

export interface ObjectCardProps {
  /** Object name (the source calls this `label`, NOT `name`). */
  label?: string;
  type?: string;
  blurb?: string;
  glyph?: ObjectCardGlyph;
  /** Pre-built icon node; falls back to an Icon for `glyph`. */
  icon?: ComponentChildren;
  status?: ObjectCardStatus;
  width?: number;
  onClick?: () => void;
}

const STATUS_VAR: Record<ObjectCardStatus, string> = {
  online: "var(--online)",
  error: "var(--error)",
  idle: "var(--idle)",
  warn: "var(--warn)",
  live: "var(--live)",
};

// glyph key → Icon name (fallback when no `icon` node is passed).
const GLYPH_ICON: Record<ObjectCardGlyph, string> = {
  machines: "computer",
  messengers: "chat",
  integrations: "weblink",
  applications: "satellite",
};

/** ObjectCard — object dialog card with icon, status, type, and blurb. */
export function ObjectCard({
  label = "Object",
  type = "OBJECT",
  blurb = "No object details available.",
  glyph = "machines",
  icon,
  status = "online",
  width = 238,
  onClick,
}: ObjectCardProps) {
  const dc = STATUS_VAR[status] ?? STATUS_VAR.online;
  const hasIcon = icon !== undefined && icon !== null && icon !== "";
  const iconEl = hasIcon ? icon : <Icon name={GLYPH_ICON[glyph] ?? GLYPH_ICON.machines} size={20} color="var(--accent-bright)" />;

  const dotStyle: JSX.CSSProperties = {
    width: "7px",
    height: "7px",
    borderRadius: "50%",
    flex: "none",
    background: dc,
    ...(status === "idle" ? {} : { boxShadow: `0 0 7px ${dc}` }),
  };

  return (
    <div
      onClick={onClick}
      class="gsv-objcard"
      style={{
        width: `${width}px`,
        position: "relative",
        background: "linear-gradient(180deg,#100e2a,var(--node-bg))",
        border: "1px solid var(--border)",
        overflow: "hidden",
        boxShadow: "0 12px 30px rgba(0,0,0,.55)",
        cursor: "pointer",
        transition: "border-color .15s,box-shadow .15s,background .15s",
        fontFamily: "var(--gsv-font-mono)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "9px",
          padding: "10px 13px",
          background: "var(--header-bar)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span style={{ display: "flex", flex: "none", color: "var(--accent-bright)" }}>{iconEl}</span>
        <span style={{ fontSize: "11px", letterSpacing: ".1em", color: "var(--accent-bright)", fontWeight: 500, flex: 1, minWidth: 0 }}>
          {label}
        </span>
        <span style={dotStyle} />
      </div>
      <div style={{ padding: "12px 13px" }}>
        <div style={{ fontSize: "8px", letterSpacing: ".22em", color: "var(--text-dim)", marginBottom: "8px" }}>{type}</div>
        <div style={{ fontSize: "10px", lineHeight: 1.55, color: "#9089d4", textWrap: "pretty" }}>{blurb}</div>
      </div>
    </div>
  );
}
