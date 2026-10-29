import { useT } from "../../i18n/locale";
import { dotGlow as sharedDotGlow } from "./StatusDot";
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

// Theme tokens, so tags follow the live light/dark theme. Idle uses
// --text-muted (dark #8c86c8, near the original #9a95cf) because --idle is too
// faint for text in both themes. Borders are the tone at reduced strength over
// whatever surface the tag sits on (fitted to the original dark hairlines);
// accent and idle borders match --border-raised and --border exactly.
const COLOR = {
  update: "var(--update)",
  online: "var(--online)",
  error: "var(--error)",
  warn: "var(--warn)",
  info: "var(--live)",
  accent: "var(--accent)",
  idle: "var(--text-muted)",
};
const BORDER = {
  update: "color-mix(in srgb, var(--update) 32%, transparent)",
  online: "color-mix(in srgb, var(--online) 25%, transparent)",
  error: "color-mix(in srgb, var(--error) 32%, transparent)",
  warn: "color-mix(in srgb, var(--warn) 38%, transparent)",
  info: "color-mix(in srgb, var(--live) 30%, transparent)",
  accent: "var(--border-raised)",
  idle: "var(--border)",
};

/** Tag — ported from Tag.dc.html. Badge in boxed or plain form, optional dot. */
export function Tag({ tone = "update", label: labelProp, boxed = false, dot = false, pulse = false, size = "small" }: TagProps) {
  const t = useT();
  const label = labelProp ?? t("ui.tag.label");
  const color = COLOR[tone] ?? COLOR.update;
  // The shared soft glow (StatusDot.css zeroes it on the light themes).
  const dotGlow = tone === "idle" ? "none" : sharedDotGlow(color);
  const dotEl = dot ? (
    <span
      class={pulse ? "gsv-tag-dot--pulse" : undefined}
      style={{ width: "6px", height: "6px", flex: "none", background: color, boxShadow: dotGlow }}
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
