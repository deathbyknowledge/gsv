import type { ComponentChildren } from "preact";
import type { JSX } from "preact";
import { Icon } from "./Icon";
import { OBJECT_GLYPH_ICON, type ObjectGlyph } from "./objectGlyph";
import "./ObjectCard.css";

export type ObjectCardGlyph = ObjectGlyph;
export type ObjectCardStatus = "online" | "error" | "idle" | "warn" | "live";

export interface ObjectCardProps {
  /** Object name (the source calls this `label`, NOT `name`). */
  label?: string;
  /** Small category shown above the name (e.g. MESSENGER, COMPUTE HOST). */
  type?: string;
  /** Description — revealed on hover. */
  blurb?: string;
  glyph?: ObjectCardGlyph;
  /** Pre-built icon node; falls back to an Icon for `glyph`. */
  icon?: ComponentChildren;
  status?: ObjectCardStatus;
  width?: number;
  onClick?: () => void;
}

const STATUS_VAR: Record<ObjectCardStatus, string> = {
  online: "var(--online)",
  error: "var(--error)",
  idle: "var(--idle)",
  warn: "var(--warn)",
  live: "var(--live)",
};

/** ObjectCard — object card with a compact category + name head and a status
 *  dot. The description is revealed on hover. */
export function ObjectCard({
  label = "Object",
  type = "OBJECT",
  blurb = "No object details available.",
  glyph = "machines",
  icon,
  status = "online",
  width = 238,
  onClick,
}: ObjectCardProps) {
  const dc = STATUS_VAR[status] ?? STATUS_VAR.online;
  const hasIcon = icon !== undefined && icon !== null && icon !== "";
  const iconEl = hasIcon ? icon : <Icon name={OBJECT_GLYPH_ICON[glyph] ?? OBJECT_GLYPH_ICON.machines} size={20} color="var(--accent-bright)" />;

  const dotStyle: JSX.CSSProperties = {
    background: dc,
    ...(status === "idle" ? {} : { boxShadow: `0 0 7px ${dc}` }),
  };

  return (
    <div class="gsv-objcard" style={{ width: `${width}px` }} onClick={onClick}>
      <div class="gsv-objcard-head">
        <span class="gsv-objcard-icon">{iconEl}</span>
        <span class="gsv-objcard-label">
          <span class="gsv-objcard-cat">{type}</span>
          <span class="gsv-objcard-name">{label}</span>
        </span>
        <span class="gsv-objcard-dot" style={dotStyle} />
      </div>
      <div class="gsv-objcard-desc">
        <p>{blurb}</p>
      </div>
    </div>
  );
}
