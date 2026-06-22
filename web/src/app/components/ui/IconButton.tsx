import type { ComponentChildren } from "preact";
import "./IconButton.css";

export type IconButtonGlyph = "back" | "arrowBack" | "menu" | "max" | "min" | "close" | "plus";
export type IconButtonSize = "small" | "medium" | "large" | number;

export interface IconButtonProps {
  glyph?: IconButtonGlyph;
  size?: IconButtonSize;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}

const SIZE_MAP: Record<"small" | "medium" | "large", number> = {
  small: 24,
  medium: 30,
  large: 38,
};

const GLYPHS: Record<IconButtonGlyph, ComponentChildren> = {
  back: (
    <svg width="40%" height="55%" viewBox="0 0 9 12">
      <path d="M9 0 L0 6 L9 12 Z" fill="currentColor" />
    </svg>
  ),
  arrowBack: (
    <svg width="50%" height="50%" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square">
      <path d="M9.5 3.5 L5 8 L9.5 12.5" />
      <path d="M5 8 H13" />
    </svg>
  ),
  menu: (
    <svg width="50%" height="50%" viewBox="0 0 16 16" shape-rendering="crispEdges">
      <g fill="currentColor">
        <rect x="2" y="3" width="3" height="10" />
        <rect x="6" y="3" width="8" height="1" />
        <rect x="6" y="12" width="8" height="1" />
        <rect x="13" y="3" width="1" height="10" />
      </g>
    </svg>
  ),
  max: (
    <svg width="46%" height="46%" viewBox="0 0 16 16">
      <g fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M3 7 L3 3 L7 3" />
        <path d="M13 9 L13 13 L9 13" />
        <line x1="3" y1="3" x2="7" y2="7" />
        <line x1="13" y1="13" x2="9" y2="9" />
      </g>
    </svg>
  ),
  min: (
    <svg width="46%" height="46%" viewBox="0 0 16 16">
      <path d="M3 6 L8 11 L13 6" fill="none" stroke="currentColor" stroke-width="1.7" />
    </svg>
  ),
  close: (
    <svg width="38%" height="38%" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="square">
      <line x1="3" y1="3" x2="13" y2="13" />
      <line x1="13" y1="3" x2="3" y2="13" />
    </svg>
  ),
  plus: (
    <svg width="50%" height="50%" viewBox="0 0 16 16" shape-rendering="crispEdges">
      <g fill="currentColor">
        <rect x="7" y="3" width="2" height="10" />
        <rect x="3" y="7" width="10" height="2" />
      </g>
    </svg>
  ),
};

/** IconButton — ported from IconButton.dc.html. Square icon button with inline
 *  SVG glyphs, named or numeric size, disabled + title + onClick. */
export function IconButton({ glyph = "back", size = "medium", disabled = false, title = "", onClick }: IconButtonProps) {
  const px = typeof size === "number" ? size : SIZE_MAP[size] ?? Number(size) ?? 30;
  const cls = disabled ? "gsv-ibtn-disabled" : "gsv-ibtn";
  return (
    <div
      class={cls}
      title={title}
      onClick={disabled ? undefined : onClick}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", width: `${px}px`, height: `${px}px` }}
    >
      {GLYPHS[glyph]}
    </div>
  );
}
