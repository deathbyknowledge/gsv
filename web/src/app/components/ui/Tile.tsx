import type { JSX } from "preact";
import { Icon } from "./Icon";
import { OBJECT_GLYPH_ICON, type ObjectGlyph } from "./objectGlyph";
import "./Tile.css";

export type TileGlyph = ObjectGlyph;
export type TileStatus = "online" | "error" | "idle" | "warn" | "live" | "update";

export interface TileProps {
  label?: string;
  glyph?: TileGlyph;
  status?: TileStatus;
  selected?: boolean;
  anchor?: boolean;
  iconSrc?: string;
  iconTitle?: string;
  iconSize?: number;
  onClick?: () => void;
}

// status tone → token (verbatim from Tile.dc.html)
const STATUS_VAR: Record<TileStatus, string> = {
  online: "var(--online)",
  error: "var(--error)",
  idle: "var(--idle)",
  warn: "var(--warn)",
  live: "var(--live)",
  update: "var(--update)",
};


/** Tile — ported from Tile.dc.html. 96px object tile with a glyph icon and a
 *  corner status dot, plus an "anchor" (GSV) circular variant. */
export function Tile({
  label,
  glyph = "machines",
  status = "online",
  selected = false,
  anchor = false,
  iconSrc,
  iconTitle,
  iconSize = 32,
  onClick,
}: TileProps) {
  const dc = STATUS_VAR[status] ?? STATUS_VAR.online;
  const labelText = label ?? (anchor ? "GSV" : "MACHINES");
  const labelColor = anchor ? "var(--text-hi)" : selected ? "var(--text-hi)" : "#cdd2e0";

  const wrapperStyle: JSX.CSSProperties = {
    display: "inline-flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "11px",
    fontFamily: "var(--gsv-font-mono)",
  };

  const dotStyle: JSX.CSSProperties = {
    position: "absolute",
    top: "8px",
    right: "8px",
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: dc,
    ...(status === "idle" ? {} : { boxShadow: `0 0 7px ${dc}` }),
  };

  if (anchor) {
    return (
      <div style={wrapperStyle}>
        <div
          onClick={onClick}
          class="gsv-tile-anchor"
          style={{
            position: "relative",
            width: "92px",
            height: "92px",
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--node-bg)",
            border: "1.4px solid var(--accent-bright)",
            boxShadow: "0 0 16px rgba(150,140,255,.45)",
            cursor: "pointer",
            transition: "transform .2s,background .2s,border-color .2s,box-shadow .2s",
          }}
        >
          <span style={{ position: "absolute", top: "-7px", left: "50%", width: "1.5px", height: "8px", background: "#e4e8f2", transform: "translateX(-50%)" }} />
          <span style={{ position: "absolute", bottom: "-7px", left: "50%", width: "1.5px", height: "8px", background: "#e4e8f2", transform: "translateX(-50%)" }} />
          <span style={{ position: "absolute", left: "-7px", top: "50%", height: "1.5px", width: "8px", background: "#e4e8f2", transform: "translateY(-50%)" }} />
          <span style={{ position: "absolute", right: "-7px", top: "50%", height: "1.5px", width: "8px", background: "#e4e8f2", transform: "translateY(-50%)" }} />
          <svg width="42" height="42" viewBox="0 0 16 16">
            <g fill="var(--text-hi)" shape-rendering="crispEdges">
              <rect x="7" y="1" width="2" height="2" />
              <rect x="6" y="3" width="4" height="6" />
              <rect x="4" y="6" width="2" height="3" />
              <rect x="10" y="6" width="2" height="3" />
              <rect x="7" y="11" width="2" height="3" fill="#a9a4ff" />
            </g>
          </svg>
        </div>
        <span style={{ fontSize: "11px", letterSpacing: ".16em", color: labelColor }}>{labelText}</span>
      </div>
    );
  }

  const iconColor = selected ? "var(--text-hi)" : "var(--node-label)";
  const iconMaskStyle: JSX.CSSProperties | null = iconSrc
    ? {
        width: `${iconSize}px`,
        height: `${iconSize}px`,
        WebkitMaskImage: `url(${iconSrc})`,
        maskImage: `url(${iconSrc})`,
      }
    : null;
  const tileSkin: JSX.CSSProperties = selected
    ? {
        background: "rgba(150,140,255,.15)",
        border: "1px solid var(--accent-bright)",
        boxShadow: "0 0 24px rgba(150,140,255,.45)",
      }
    : {
        background: "var(--panel)",
        border: "1px solid var(--border)",
        boxShadow: "0 6px 18px rgba(0,0,0,.45)",
      };

  return (
    <div style={wrapperStyle}>
      <div
        onClick={onClick}
        class="gsv-tile"
        style={{
          position: "relative",
          width: "96px",
          height: "96px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          transition: "transform .2s,background .2s,border-color .2s,box-shadow .2s",
          ...tileSkin,
        }}
      >
        <span style={dotStyle} />
        <span style={{ display: "flex", color: iconColor }}>
          {iconMaskStyle ? (
            <span
              class="gsv-icon"
              role="img"
              aria-label={iconTitle ?? labelText}
              style={iconMaskStyle}
            />
          ) : (
            <Icon
              name={OBJECT_GLYPH_ICON[glyph] ?? OBJECT_GLYPH_ICON.machines}
              size={iconSize}
              dotMatrix={16}
              title={iconTitle ?? labelText}
            />
          )}
        </span>
      </div>
      <span style={{ fontSize: "11px", letterSpacing: ".16em", color: labelColor }}>{labelText}</span>
    </div>
  );
}
