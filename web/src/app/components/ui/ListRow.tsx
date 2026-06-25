import type { JSX } from "preact";
import { Icon } from "./Icon";
import { Tag, type TagTone } from "./Tag";
import "./ListRow.css";

export type ListRowStatus = "online" | "error" | "idle" | "live" | "none" | "update" | "warn";
export type ListRowStatusDotPlacement = "leading" | "trailing";

export interface ListRowProps {
  className?: string;
  label?: string;
  status?: ListRowStatus;
  statusLabel?: string;
  sub?: string;
  tag?: string;
  tagTone?: TagTone;
  chevron?: boolean;
  icon?: string;
  iconTitle?: string;
  statusDotPlacement?: ListRowStatusDotPlacement;
  style?: JSX.CSSProperties;
  active?: boolean;
  onClick?: () => void;
}

const STATUS_TEXT: Record<Exclude<ListRowStatus, "none">, string> = {
  online: "var(--online)",
  error: "var(--error)",
  idle: "#9a95cf",
  live: "var(--live)",
  update: "var(--update)",
  warn: "var(--warn)",
};

const DOT_COLOR: Record<Exclude<ListRowStatus, "none">, string> = {
  online: "var(--online)",
  error: "var(--error)",
  idle: "var(--idle)",
  live: "var(--live)",
  update: "var(--update)",
  warn: "var(--warn)",
};

/** ListRow — full-width clickable row with status, optional tag/status text, and chevron. */
export function ListRow({
  className = "",
  label = "Item",
  status = "online",
  statusLabel = "",
  sub = "",
  tag = "",
  tagTone = "update",
  chevron = false,
  icon,
  iconTitle,
  statusDotPlacement = "leading",
  style,
  active = false,
  onClick,
}: ListRowProps) {
  const st = status || "online";
  const hasDot = st !== "none";
  const dotKey = (st === "none" ? "online" : st) as Exclude<ListRowStatus, "none">;
  const dc = DOT_COLOR[dotKey];
  const dotClass = `lr-dot${statusDotPlacement === "trailing" ? " is-trailing" : ""}`;

  const rootStyle: JSX.CSSProperties = {
    width: "100%",
    maxWidth: "100%",
    minWidth: 0,
    boxSizing: "border-box",
    appearance: "none",
    border: 0,
    background: active ? "var(--active)" : "transparent",
    color: "inherit",
    display: "flex",
    alignItems: "center",
    gap: "14px",
    overflow: "hidden",
    padding: "15px 20px",
    cursor: onClick ? "pointer" : "default",
    transition: "background .12s",
    font: "inherit",
    fontFamily: "var(--gsv-font-mono)",
    textAlign: "left",
  };

  const dotStyle: JSX.CSSProperties = {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    flex: "none",
    background: dc,
    ...(st === "idle" ? {} : { boxShadow: `0 0 7px ${dc}` }),
  };

  const content = (
    <>
      {icon ? (
        <span class="lr-icon">
          <Icon name={icon} size={18} title={iconTitle ?? label} />
        </span>
      ) : null}
      {hasDot && statusDotPlacement === "leading" ? <span class={dotClass} style={dotStyle} /> : null}
      <div class="lr-main" style={{ flex: "1 1 0", minWidth: 0, maxWidth: "100%", overflow: "hidden" }}>
        <div
          class="lr-label"
          style={{
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: "12.5px",
            letterSpacing: ".04em",
            color: "var(--text)",
          }}
        >
          {label}
        </div>
        {sub ? (
          <div
            class="lr-sub"
            style={{
              maxWidth: "100%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: "10px",
              letterSpacing: ".04em",
              color: "#8c86c8",
              marginTop: "6px",
            }}
          >
            {sub}
          </div>
        ) : null}
      </div>
      {tag ? <span class="lr-tag" style={{ flex: "none" }}><Tag label={tag} tone={tagTone} boxed /></span> : null}
      {statusLabel ? (
        <span class="lr-status" style={{ flex: "none", fontSize: "9px", letterSpacing: ".12em", color: STATUS_TEXT[dotKey] }}>
          {statusLabel}
        </span>
      ) : null}
      {hasDot && statusDotPlacement === "trailing" ? <span class={dotClass} style={dotStyle} /> : null}
      {chevron ? (
        <span class="lr-chevron" style={{ display: "inline-flex", flex: "none", alignItems: "center" }}>
          <svg width="9" height="12" viewBox="0 0 9 12" aria-hidden="true" style={{ filter: "drop-shadow(0 0 3px rgba(150,140,255,.5))" }}>
            <path d="M0 0 L9 6 L0 12 Z" fill="var(--accent)" />
          </svg>
        </span>
      ) : null}
    </>
  );

  const rootClass = `lr${className ? ` ${className}` : ""}`;
  const mergedStyle = style ? { ...rootStyle, ...style } : rootStyle;

  return onClick ? (
    <button type="button" onClick={onClick} class={rootClass} data-clickable="true" style={mergedStyle}>
      {content}
    </button>
  ) : (
    <div class={rootClass} style={mergedStyle}>
      {content}
    </div>
  );
}
