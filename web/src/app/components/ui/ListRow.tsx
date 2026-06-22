import type { JSX } from "preact";
import "./ListRow.css";

export type ListRowStatus = "online" | "error" | "idle" | "live" | "none" | "update" | "warn";

export interface ListRowProps {
  label?: string;
  status?: ListRowStatus;
  statusLabel?: string;
  sub?: string;
  tag?: string;
  chevron?: boolean;
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
  label = "Item",
  status = "online",
  statusLabel = "",
  sub = "",
  tag = "",
  chevron = false,
  active = false,
  onClick,
}: ListRowProps) {
  const st = status || "online";
  const hasDot = st !== "none";
  const dotKey = (st === "none" ? "online" : st) as Exclude<ListRowStatus, "none">;
  const dc = DOT_COLOR[dotKey];

  const rootStyle: JSX.CSSProperties = {
    width: "100%",
    appearance: "none",
    border: 0,
    background: active ? "var(--active)" : "transparent",
    color: "inherit",
    display: "flex",
    alignItems: "center",
    gap: "14px",
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
      {hasDot ? <span class="lr-dot" style={dotStyle} /> : null}
      <div class="lr-main" style={{ flex: 1, minWidth: 0 }}>
        <div class="lr-label" style={{ fontSize: "12.5px", letterSpacing: ".04em", color: "var(--text)" }}>{label}</div>
        {sub ? (
          <div class="lr-sub" style={{ fontSize: "10px", letterSpacing: ".04em", color: "#8c86c8", marginTop: "6px" }}>{sub}</div>
        ) : null}
      </div>
      {tag ? (
        <span
          class="lr-tag"
          style={{
            flex: "none",
            fontSize: "8.5px",
            letterSpacing: ".14em",
            color: "var(--update)",
            border: "1px solid #5a4a1f",
            padding: "3px 7px",
          }}
        >
          {tag}
        </span>
      ) : null}
      {statusLabel ? (
        <span class="lr-status" style={{ flex: "none", fontSize: "9px", letterSpacing: ".12em", color: STATUS_TEXT[dotKey] }}>
          {statusLabel}
        </span>
      ) : null}
      {chevron ? (
        <span class="lr-chevron" style={{ display: "inline-flex", flex: "none", alignItems: "center" }}>
          <svg width="9" height="12" viewBox="0 0 9 12" style={{ filter: "drop-shadow(0 0 3px rgba(150,140,255,.5))" }}>
            <path d="M0 0 L9 6 L0 12 Z" fill="var(--accent)" />
          </svg>
        </span>
      ) : null}
    </>
  );

  return onClick ? (
    <button type="button" onClick={onClick} class="lr" data-clickable="true" style={rootStyle}>
      {content}
    </button>
  ) : (
    <div class="lr" style={rootStyle}>
      {content}
    </div>
  );
}
