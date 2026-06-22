import { Fragment } from "preact";
import type { JSX } from "preact";
import "./ConsoleHeader.css";

export interface ConsoleCrumb {
  label: string;
  onClick?: () => void;
  /** Inline style override; falls back to the active/inactive crumb style. */
  style?: JSX.CSSProperties;
  /** When omitted, the last crumb is treated as active. */
  notLast?: boolean;
}

export interface ConsoleHeaderProps {
  /** Dynamic, clickable breadcrumbs. Takes precedence over c0/c1/c2. */
  crumbs?: ConsoleCrumb[];
  c0?: string;
  c1?: string;
  c2?: string;
  tail?: string;
  onBack?: () => void;
}

const activeStyle: JSX.CSSProperties = {
  fontSize: "11px",
  letterSpacing: ".16em",
  color: "var(--text-hi)",
  textShadow: "0 0 6px rgba(150,140,255,.4)",
};

const inactiveStyle: JSX.CSSProperties = {
  fontSize: "11px",
  letterSpacing: ".16em",
  color: "#9d98d8",
  cursor: "pointer",
};

const styleFor = (last: boolean): JSX.CSSProperties => (last ? activeStyle : inactiveStyle);

interface ResolvedCrumb {
  label: string;
  notLast: boolean;
  onClick: () => void;
  style: JSX.CSSProperties;
}

/** ConsoleHeader — top console bar with back, live indicator, breadcrumbs, and tail label. */
export function ConsoleHeader({
  crumbs,
  c0 = "GSV",
  c1 = "SYSTEM",
  c2 = "",
  tail = "GSV",
  onBack,
}: ConsoleHeaderProps) {
  const noop = () => {};

  let resolved: ResolvedCrumb[];
  if (Array.isArray(crumbs) && crumbs.length) {
    const n = crumbs.length;
    resolved = crumbs.map((c, i) => {
      const last = c.notLast !== undefined ? !c.notLast : i === n - 1;
      return { label: c.label, notLast: !last, onClick: c.onClick ?? noop, style: c.style ?? styleFor(last) };
    });
  } else {
    const raw = [c0, c1, c2].filter(Boolean) as string[];
    resolved = raw.map((label, i) => {
      const last = i === raw.length - 1;
      return { label, notLast: !last, onClick: noop, style: styleFor(last) };
    });
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "16px",
        padding: "16px 26px",
        borderBottom: "1px solid var(--border)",
        fontFamily: "var(--gsv-font-mono)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
        <div onClick={onBack} class="gsv-ch-back">
          <svg width="9" height="12" viewBox="0 0 9 12">
            <path d="M9 0 L0 6 L9 12 Z" fill="var(--accent)" />
          </svg>
        </div>
        <span
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            flex: "none",
            background: "var(--live)",
            boxShadow: "0 0 9px var(--live)",
            animation: "gsvPulse 1.5s ease-in-out infinite",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: "9px", minWidth: 0, flexWrap: "wrap" }}>
          {resolved.map((c, i) => (
            <Fragment key={i}>
              <span onClick={c.onClick} style={c.style}>
                {c.label}
              </span>
              {c.notLast ? <span style={{ color: "var(--text-dim)", fontSize: "12px" }}>/</span> : null}
            </Fragment>
          ))}
        </div>
      </div>
      <span style={{ fontSize: "11px", letterSpacing: ".18em", color: "var(--text-dim)", flex: "none" }}>{tail}</span>
    </div>
  );
}
