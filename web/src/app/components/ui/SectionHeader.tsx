import type { ComponentChildren, JSX } from "preact";
import "../../../styles/gsv-type.css";
import "./SectionHeader.css";

export interface SectionHeaderProps {
  chevron?: boolean;
  className?: string;
  density?: "default" | "compact";
  title?: string;
  meta?: string;
  /** Lower-priority trailing word after `meta` (e.g. "CONFIGURED" in
   *  "5/6 CONFIGURED"). It is the first thing dropped under tight space — wire a
   *  container query against `.gsv-section-header-metaword` to hide it — so the
   *  leading `meta` token (the count) and the title both survive. */
  metaWord?: string;
  divider?: boolean;
  titleSize?: "section" | "title";
  /** Heading level for the title element. Defaults to 2 → <h2>. The title is
   *  always a real heading for a11y; this controls which level. */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Accessible name for the clickable (onClick) variant. Use when the title is
   *  glyph-only or otherwise not descriptive. */
  ariaLabel?: string;
  /** Right-aligned interactive controls (e.g. a close ✕ or page actions). They
   *  sit after `meta`, never shrink, and keep their own focus/labels. Safe to
   *  combine with `onClick`: the title is the row button, so actions stay
   *  independently clickable. */
  actions?: ComponentChildren;
  onClick?: () => void;
}

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

/** SectionHeader — ported from SectionHeader.dc.html. Header bar with a square
 *  accent dot, Departure Mono title, optional meta (right-aligned), optional
 *  actions slot (far right), and a divider variant (bottom rule instead of full
 *  border).
 *
 *  The title is always a real heading element (<h{headingLevel}>). When
 *  `onClick` is set, only the title becomes the interactive button — the row
 *  itself is never a button — so the heading semantics survive and any `actions`
 *  remain independently clickable. */
export function SectionHeader({
  chevron = false,
  className = "",
  density = "default",
  title = "THE SHIP",
  meta = "",
  metaWord = "",
  divider = false,
  titleSize,
  headingLevel = 2,
  ariaLabel,
  actions,
  onClick,
}: SectionHeaderProps) {
  const hasMeta = !!meta;
  const hasMetaWord = !!metaWord;
  const hasActions = actions != null && actions !== false;
  // Full-row click: only safe when there are no independently-clickable actions
  // (a stretched overlay would cover them). The title stays the accessible name.
  const rowClick = !!onClick && !hasActions;
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
    // min-width:0 so the header never overflows a narrow docked column and the
    // title can ellipsize inside it.
    minWidth: 0,
  };
  const rootClass = [
    "gsv-section-header",
    density === "compact" ? "is-compact" : "",
    onClick ? "is-clickable" : "",
    rowClick ? "is-rowclick" : "",
    className,
  ].filter(Boolean).join(" ");

  const Heading = (`h${headingLevel}` as HeadingTag);

  // Type class + the existing inline title look. margin:0 resets default
  // heading margins so layout is identical to the old <span>.
  // Title size: an explicit `titleSize` wins; otherwise it derives from the
  // heading level down the DS type scale (Title > Section > Sub-label) so an
  // <h3> is smaller than an <h2> by definition.
  const titleClass = titleSize === "title"
    ? "gsv-title"
    : titleSize === "section"
      ? "gsv-section"
      : headingLevel <= 1
        ? "gsv-title"
        : headingLevel === 2
          ? "gsv-section"
          : "gsv-sublabel";
  const titleVisualStyle: JSX.CSSProperties = {
    color: "var(--text-title)",
    textShadow: "0 0 5px rgba(150,140,255,.3)",
    margin: 0,
  };
  // Truncation: the title is the flexible child — it shrinks and ellipsizes so
  // it never collides with meta/actions. App docks panels, so viewport @media
  // won't fire for narrow columns; flex + min-width:0 handles it instead.
  const titleTruncStyle: JSX.CSSProperties = {
    flex: "1 1 auto",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };

  const heading = onClick ? (
    <Heading class={`gsv-section-header-title ${titleClass}`} style={{ ...titleVisualStyle, ...titleTruncStyle }}>
      <button
        type="button"
        class="gsv-section-header-titlebtn"
        aria-label={ariaLabel}
        onClick={onClick}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {title}
      </button>
    </Heading>
  ) : (
    <Heading
      class={`gsv-section-header-title ${titleClass}`}
      aria-label={ariaLabel}
      style={{ ...titleVisualStyle, ...titleTruncStyle }}
    >
      {title}
    </Heading>
  );

  return (
    <div class={rootClass} data-clickable={onClick ? "true" : undefined} style={rootStyle}>
      <span
        aria-hidden="true"
        style={{
          width: "7px",
          height: "7px",
          flex: "none",
          borderRadius: "1px",
          background: "var(--accent)",
          boxShadow: "0 0 8px var(--accent)",
        }}
      />
      {heading}
      {hasMeta ? (
        // meta is the dim eyebrow string (var(--meta)); pinned right, never
        // shrinks. (Contrast: --meta is intentionally dim per design tokens.)
        <span class="gsv-section-header-meta" style={{ marginLeft: "auto", flex: "none", fontSize: "10px", letterSpacing: ".16em", color: "var(--meta)" }}>{meta}</span>
      ) : null}
      {hasMetaWord ? (
        <span class="gsv-section-header-metaword" style={{ marginLeft: hasMeta ? undefined : "auto", flex: "none", fontSize: "10px", letterSpacing: ".16em", color: "var(--meta)" }}>{metaWord}</span>
      ) : null}
      {chevron ? <span class="gsv-section-header-chevron" aria-hidden="true" /> : null}
      {hasActions ? (
        <span class="gsv-section-header-actions" style={{ marginLeft: hasMeta ? undefined : "auto", flex: "none", display: "inline-flex", alignItems: "center", gap: density === "compact" ? "8px" : "11px" }}>
          {actions}
        </span>
      ) : null}
    </div>
  );
}
