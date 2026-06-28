import type { JSX } from "preact";
import { Breadcrumbs, type Crumb } from "./Breadcrumbs";
import { IconButton } from "./IconButton";
import "./ConsoleHeader.css";

export interface ConsoleCrumb {
  label: string;
  onClick?: () => void;
  /** @deprecated Crumb styling is owned by the DS Breadcrumbs now; ignored. */
  style?: JSX.CSSProperties;
  /** @deprecated The current crumb is derived from position; ignored. */
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
  /** When provided, renders a top-right (X) button that closes the screen. */
  onClose?: () => void;
}

/** ConsoleHeader — top console bar with back, live indicator, breadcrumbs, and
 *  tail label. The breadcrumb trail is the shared, semantic DS `Breadcrumbs`
 *  (one `<nav>`/`<ol>`/`aria-current` implementation across the whole app). */
export function ConsoleHeader({
  crumbs,
  c0 = "GSV",
  c1 = "SYSTEM",
  c2 = "",
  tail = "GSV",
  onBack,
  onClose,
}: ConsoleHeaderProps) {
  const items: Crumb[] =
    Array.isArray(crumbs) && crumbs.length
      ? crumbs.map((c) => ({ label: c.label, onClick: c.onClick }))
      : ([c0, c1, c2].filter(Boolean) as string[]).map((label) => ({ label }));

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
        <button
          type="button"
          aria-label="Back"
          class="gsv-ch-back"
          disabled={!onBack}
          onClick={onBack}
        >
          <svg width="9" height="12" viewBox="0 0 9 12" aria-hidden="true">
            <path d="M9 0 L0 6 L9 12 Z" fill="var(--accent)" />
          </svg>
        </button>
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
        <Breadcrumbs items={items} size="medium" />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "12px", flex: "none" }}>
        <span style={{ fontSize: "11px", letterSpacing: ".18em", color: "var(--text-dim)" }}>{tail}</span>
        {onClose ? (
          <IconButton glyph="close" size="small" title="Close" ariaLabel="Close screen" onClick={onClose} />
        ) : null}
      </div>
    </div>
  );
}
