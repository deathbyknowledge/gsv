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
 *  with a pulsing live dot + title + close affordance, over a 4-cell grid of
 *  FILES / LIBRARY / TERMINAL / SETTINGS controls. */
export function IconMenu({
  title = "GSV // CONTROL",
  width = 386,
  onClose,
  onFiles,
  onLibrary,
  onTerminal,
  onSettings,
}: IconMenuProps) {
  return (
    <div
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
        <span
          onClick={onClose}
          style={{ fontSize: "11px", color: "var(--text-dim)", cursor: "pointer", letterSpacing: ".12em" }}
        >
          [ X ]
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4,1fr)",
          gap: "1px",
          background: "var(--rule-inner)",
          padding: "1px",
        }}
      >
        <div onClick={onFiles} class="gsv-im-cell" style={{ color: "var(--accent-bright)" }}>
          <Icon name="folder" size={22} />
          <span style={{ fontSize: "9px", letterSpacing: ".16em", color: "#7d78b8" }}>FILES</span>
        </div>
        <div onClick={onLibrary} class="gsv-im-cell" style={{ color: "var(--accent-bright)" }}>
          <Icon name="pencil" size={22} />
          <span style={{ fontSize: "9px", letterSpacing: ".16em", color: "#7d78b8" }}>LIBRARY</span>
        </div>
        <div onClick={onTerminal} class="gsv-im-cell" style={{ color: "var(--accent-bright)" }}>
          <Icon name="terminal" size={22} />
          <span style={{ fontSize: "9px", letterSpacing: ".16em", color: "#7d78b8" }}>TERMINAL</span>
        </div>
        <div onClick={onSettings} class="gsv-im-cell" style={{ color: "#b6b1ff" }}>
          <Icon name="cog" size={22} />
          <span style={{ fontSize: "9px", letterSpacing: ".16em", color: "#b6b1ff" }}>SETTINGS</span>
        </div>
      </div>
    </div>
  );
}
