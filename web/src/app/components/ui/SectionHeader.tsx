import type { JSX } from "preact";
import "../../../styles/gsv-type.css";
import "./SectionHeader.css";

export interface SectionHeaderProps {
  chevron?: boolean;
  className?: string;
  density?: "default" | "compact";
  title?: string;
  meta?: string;
  divider?: boolean;
  titleSize?: "section" | "title";
  onClick?: () => void;
}

/** SectionHeader — ported from SectionHeader.dc.html. Header bar with a square
 *  accent dot, Departure Mono title, optional meta (right-aligned) and a
 *  divider variant (bottom rule instead of full border). */
export function SectionHeader({
  chevron = false,
  className = "",
  density = "default",
  title = "THE SHIP",
  meta = "",
  divider = false,
  titleSize = "section",
  onClick,
}: SectionHeaderProps) {
  const hasMeta = !!meta;
  const rootStyle: JSX.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: density === "compact" ? "8px" : "11px",
    padding: density === "compact" ? "9px 16px" : "14px 20px",
    ...(divider ? { border: 0, borderBottom: "1px solid var(--border)" } : { border: "1px solid var(--border)" }),
    background: "var(--header-bar)",
    color: "inherit",
    font: "inherit",
    fontFamily: "var(--gsv-font-mono)",
    textAlign: "left",
    width: "100%",
  };
  const rootClass = [
    "gsv-section-header",
    density === "compact" ? "is-compact" : "",
    onClick ? "is-clickable" : "",
    className,
  ].filter(Boolean).join(" ");

  const content = (
    <>
      <span
        style={{
          width: "7px",
          height: "7px",
          flex: "none",
          borderRadius: "1px",
          background: "var(--accent)",
          boxShadow: "0 0 8px var(--accent)",
        }}
      />
      <span
        class={titleSize === "title" ? "gsv-title" : "gsv-section"}
        style={{
          color: "var(--text-title)",
          textShadow: "0 0 5px rgba(150,140,255,.3)",
        }}
      >
        {title}
      </span>
      {hasMeta ? (
        <span class="gsv-section-header-meta" style={{ marginLeft: "auto", fontSize: "10px", letterSpacing: ".16em", color: "var(--meta)" }}>{meta}</span>
      ) : null}
      {chevron ? <span class="gsv-section-header-chevron" aria-hidden="true" /> : null}
    </>
  );

  return onClick ? (
    <button type="button" class={rootClass} data-clickable="true" style={rootStyle} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div class={rootClass} style={rootStyle}>
      {content}
    </div>
  );
}
