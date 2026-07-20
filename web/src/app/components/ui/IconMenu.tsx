import { useEffect, useRef } from "preact/hooks";
import { Icon, type DotIconMatrix } from "./Icon";
import "./IconMenu.css";

export interface IconMenuCell {
  /** Icon name (gsv family, or a doticons/… path with `dotMatrix`). */
  icon: string;
  label: string;
  onClick?: () => void;
  /** Highlighted cell (the brighter purple used by the old SETTINGS cell). */
  accent?: boolean;
  dotMatrix?: DotIconMatrix;
}

export interface IconMenuProps {
  title?: string;
  /** Popover width in px (280–480). */
  width?: number;
  /** Move focus to the first action on mount. Disable for hover previews so the
   *  menu doesn't steal focus from another control just by being shown. */
  autoFocus?: boolean;
  onClose?: () => void;
  cells: IconMenuCell[];
}

/** IconMenu — ported from IconMenu.dc.html. GSV control popover: a header bar
 *  with a pulsing live dot + title + close affordance, over a grid of cells. */
export function IconMenu({
  title = "GSV // CONTROL",
  width = 386,
  autoFocus = true,
  onClose,
  cells,
}: IconMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  // Move focus to the first enabled action button (or the close button) once the
  // menu is genuinely opened. Keyed on autoFocus so a hover preview that later
  // becomes a real open (without remounting) still pulls focus at that point.
  useEffect(() => {
    if (!autoFocus) return;
    const root = rootRef.current;
    if (!root) return;
    const firstEnabledCell = root.querySelector<HTMLButtonElement>(".gsv-im-cell:not(:disabled)");
    const closeButton = root.querySelector<HTMLButtonElement>(".gsv-im-close");
    (firstEnabledCell ?? closeButton)?.focus();
  }, [autoFocus]);

  // Escape closes the menu.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={title}
      class="gsv-im"
      style={{
        width: `${width}px`,
        maxWidth: "100%",
        position: "relative",
        background: "linear-gradient(180deg,#100e2a,var(--node-bg))",
        border: "1px solid var(--border)",
        overflow: "hidden",
        boxShadow: "0 18px 50px rgba(0,0,0,.6)",
        fontFamily: "var(--gsv-font-mono)",
      }}
    >
      <span class="gsv-im-bracket gsv-im-tl" />
      <span class="gsv-im-bracket gsv-im-tr" />
      <span class="gsv-im-bracket gsv-im-bl" />
      <span class="gsv-im-bracket gsv-im-br" />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          background: "var(--header-bar)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
          <span
            aria-hidden="true"
            style={{
              width: "7px",
              height: "7px",
              borderRadius: "50%",
              background: "var(--live)",
              boxShadow: "0 0 7px var(--live)",
              animation: "gsvPulse 1.5s ease-in-out infinite",
            }}
          />
          <span class="gsv-label" style={{ letterSpacing: ".24em", color: "var(--accent-bright)" }}>{title}</span>
        </div>
        <button type="button" aria-label="Close menu" class="gsv-im-close gsv-label" disabled={!onClose} onClick={onClose}>
          [ X ]
        </button>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${Math.max(cells.length, 1)},minmax(0,1fr))`,
          gap: "1px",
          background: "var(--rule-inner)",
          padding: "1px",
        }}
      >
        {cells.map((cell) => (
          <button
            key={cell.label}
            type="button"
            disabled={!cell.onClick}
            onClick={cell.onClick}
            class="gsv-im-cell"
            style={{ color: cell.accent ? "#b6b1ff" : "var(--accent-bright)" }}
          >
            <Icon name={cell.icon} size={22} dotMatrix={cell.dotMatrix} />
            <span class="gsv-sublabel" style={{ letterSpacing: ".16em", color: cell.accent ? "#b6b1ff" : "#7d78b8" }}>
              {cell.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
