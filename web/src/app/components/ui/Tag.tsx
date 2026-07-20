import "./Tag.css";

export type TagTone = "update" | "online" | "error" | "warn" | "info" | "accent" | "idle";
export type TagSize = "small" | "medium";

export interface TagProps {
  tone?: TagTone;
  label?: string;
  boxed?: boolean;
  dot?: boolean;
  /** Blink the dot while an action is in progress. */
  pulse?: boolean;
  size?: TagSize;
}

// Transcribed verbatim from Tag.dc.html (literal hex; not all tones map to tokens).
const COLOR: Record<TagTone, string> = {
  update: "#ffd24d",
  online: "#5ef2a0",
  error: "#ff6f8c",
  warn: "#e0a64c",
  info: "#8f8aff",
  accent: "#b3aeff",
  idle: "#9a95cf",
};
const BORDER: Record<TagTone, string> = {
  update: "#5a4a1f",
  online: "#1c4a32",
  error: "#5a2b3a",
  warn: "#5a4a1f",
  info: "#2e2a6a",
  accent: "#4a449e",
  idle: "#322e74",
};

/** Tag — ported from Tag.dc.html. Badge in boxed or plain form, optional dot. */
export function Tag({ tone = "update", label = "UPDATE", boxed = false, dot = false, pulse = false, size = "small" }: TagProps) {
  const color = COLOR[tone] ?? COLOR.update;
  const dotGlow = tone === "idle" ? "none" : `0 0 6px ${color}`;
  const dotEl = dot ? (
    <span
      class={pulse ? "gsv-tag-dot--pulse" : undefined}
      style={{ width: "6px", height: "6px", borderRadius: "50%", flex: "none", background: color, boxShadow: dotGlow }}
    />
  ) : null;

  if (boxed) {
    return (
      <span style={{ fontFamily: "var(--gsv-font-mono)", display: "inline-flex" }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            letterSpacing: "0.14em",
            fontSize: size === "medium" ? "9.5px" : "8.5px",
            color,
            border: `1px solid ${BORDER[tone] ?? BORDER.update}`,
            padding: size === "medium" ? "4px 9px" : "3px 7px",
          }}
        >
          {dotEl}
          <span>{label}</span>
        </span>
      </span>
    );
  }

  return (
    <span style={{ fontFamily: "var(--gsv-font-mono)", display: "inline-flex" }}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          letterSpacing: "0.12em",
          fontSize: size === "medium" ? "10px" : "9px",
          color,
        }}
      >
        {dotEl}
        <span>{label}</span>
      </span>
    </span>
  );
}
