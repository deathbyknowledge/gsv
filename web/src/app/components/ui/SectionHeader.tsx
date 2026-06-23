import "../../../styles/gsv-type.css";

export interface SectionHeaderProps {
  title?: string;
  meta?: string;
  divider?: boolean;
  titleSize?: "section" | "title";
}

/** SectionHeader — ported from SectionHeader.dc.html. Header bar with a square
 *  accent dot, Departure Mono title, optional meta (right-aligned) and a
 *  divider variant (bottom rule instead of full border). */
export function SectionHeader({ title = "THE SHIP", meta = "", divider = false, titleSize = "section" }: SectionHeaderProps) {
  const hasMeta = !!meta;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "11px",
        padding: "14px 20px",
        ...(divider ? { borderBottom: "1px solid var(--border)" } : { border: "1px solid var(--border)" }),
        background: "var(--header-bar)",
        fontFamily: "var(--gsv-font-mono)",
      }}
    >
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
        <span style={{ marginLeft: "auto", fontSize: "10px", letterSpacing: ".16em", color: "#7d78b8" }}>{meta}</span>
      ) : null}
    </div>
  );
}
