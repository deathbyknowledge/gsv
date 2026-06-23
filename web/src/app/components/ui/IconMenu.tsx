import { useEffect, useRef } from "preact/hooks";
import { Icon } from "./Icon";
import "./IconMenu.css";

export interface IconMenuProps {
  title?: string;
  /** Popover width in px (280–480). */
  width?: number;
  onClose?: () => void;
  onFiles?: () => void;
  onLibrary?: () => void;
  onTerminal?: () => void;
  onSettings?: () => void;
}

/** IconMenu — ported from IconMenu.dc.html. GSV control popover: a header bar
 *  with a pulsing live dot + title + close affordance, over a grid of GSV controls. */
export function IconMenu({
  title = "GSV // CONTROL",
  width = 386,
  onClose,
  onFiles,
  onLibrary,
  onTerminal,
  onSettings,
}: IconMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  // On mount: move focus to the first enabled action button (or the close button).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const firstEnabledCell = root.querySelector<HTMLButtonElement>(".gsv-im-cell:not(:disabled)");
    const closeButton = root.querySelector<HTMLButtonElement>(".gsv-im-close");
    (firstEnabledCell ?? closeButton)?.focus();
  }, []);

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
          <span style={{ fontSize: "11px", letterSpacing: ".24em", color: "var(--accent-bright)" }}>{title}</span>
        </div>
        <button type="button" aria-label="Close menu" class="gsv-im-close" disabled={!onClose} onClick={onClose}>
          [ X ]
        </button>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4,minmax(0,1fr))",
          gap: "1px",
          background: "var(--rule-inner)",
          padding: "1px",
        }}
      >
        <button type="button" disabled={!onFiles} onClick={onFiles} class="gsv-im-cell" style={{ color: "var(--accent-bright)" }}>
          <Icon name="folder" size={22} />
          <span style={{ fontSize: "9px", letterSpacing: ".16em", color: "#7d78b8" }}>FILES</span>
        </button>
        <button type="button" disabled={!onLibrary} onClick={onLibrary} class="gsv-im-cell" style={{ color: "var(--accent-bright)" }}>
          <Icon name="pencil" size={22} />
          <span style={{ fontSize: "9px", letterSpacing: ".16em", color: "#7d78b8" }}>LIBRARY</span>
        </button>
        <button type="button" disabled={!onTerminal} onClick={onTerminal} class="gsv-im-cell" style={{ color: "var(--accent-bright)" }}>
          <Icon name="terminal" size={22} />
          <span style={{ fontSize: "9px", letterSpacing: ".16em", color: "#7d78b8" }}>TERMINAL</span>
        </button>
        <button type="button" disabled={!onSettings} onClick={onSettings} class="gsv-im-cell" style={{ color: "#b6b1ff" }}>
          <Icon name="cog" size={22} />
          <span style={{ fontSize: "9px", letterSpacing: ".16em", color: "#b6b1ff" }}>SETTINGS</span>
        </button>
      </div>
    </div>
  );
}
