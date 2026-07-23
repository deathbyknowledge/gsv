import type { ComponentChildren } from "preact";
import "./IconButton.css";

export type IconButtonGlyph = "back" | "arrowBack" | "menu" | "max" | "min" | "close" | "plus" | "help" | "attention" | "refresh" | "newTab" | "attach" | "transcribe" | "mic" | "send" | "stop" | "sidepanel" | "edit";
export type IconButtonSize = "small" | "medium" | "large" | number;
/** Visual treatment. "default" = filled box with border; "floating" = borderless
 *  and transparent, glyph-only, with a color-shift on hover (for use inside bars
 *  like the message composer). "ghost" is kept as a legacy alias via the `ghost`
 *  prop for the inline info hint. */
export type IconButtonVariant = "default" | "floating";

export interface IconButtonProps {
  glyph?: IconButtonGlyph;
  size?: IconButtonSize;
  disabled?: boolean;
  /** Visual treatment (see IconButtonVariant). Ignored when `ghost` is set. */
  variant?: IconButtonVariant;
  /** Borderless rendering (no background/border) — for inline affordances such
   *  as the label info hint. Legacy; prefer `variant="floating"` for new uses. */
  ghost?: boolean;
  /** Extra class(es) appended to the button — lets callers layer state tones
   *  (e.g. a send/stop or active colour) over the base variant. */
  className?: string;
  /** Native browser tooltip text. Also used as the accessible name unless
   *  ariaLabel is given. Omit when a custom tooltip already labels the control
   *  (e.g. InfoTip) to avoid a duplicate native tooltip. */
  title?: string;
  /** Accessible name without rendering a native title tooltip. Takes precedence
   *  over title for aria-label. */
  ariaLabel?: string;
  /** id of an element that describes this control (e.g. a tooltip bubble).
   *  Accepts either camelCase or the DOM-style `aria-describedby` (the latter is
   *  what Tooltip/Hint injects via cloneElement). */
  ariaDescribedBy?: string;
  "aria-describedby"?: string;
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
  help: (
    <svg width="72%" height="72%" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.2" />
      <text
        x="8"
        y="11.55"
        text-anchor="middle"
        font-size="9.5"
        font-weight="700"
        font-family="ui-sans-serif, system-ui, sans-serif"
        fill="currentColor"
        stroke="none"
      >
        ?
      </text>
    </svg>
  ),
  attention: (
    <svg width="72%" height="72%" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.2" />
      <text
        x="8"
        y="11.55"
        text-anchor="middle"
        font-size="9.5"
        font-weight="700"
        font-family="ui-sans-serif, system-ui, sans-serif"
        fill="currentColor"
        stroke="none"
      >
        !
      </text>
    </svg>
  ),
  refresh: (
    <svg width="50%" height="50%" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square">
      <path d="M12.5 4.5 A5 5 0 1 0 13.2 9.5" />
      <path d="M12.5 1.5 L12.5 4.5 L9.5 4.5" />
    </svg>
  ),
  newTab: (
    <svg width="50%" height="50%" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square">
      <path d="M8 3 L3 3 L3 13 L13 13 L13 8" />
      <path d="M9 7 L13 3" />
      <path d="M9.5 3 L13 3 L13 6.5" />
    </svg>
  ),
  attach: (
    <svg width="58%" height="58%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  ),
  transcribe: (
    <svg width="60%" height="60%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6.5 3.5 h11 a3.5 3.5 0 0 1 3.5 3.5 v5.5 a3.5 3.5 0 0 1-3.5 3.5 h-5.5 l-4 3 v-3 h-1 a3.5 3.5 0 0 1-3.5-3.5 v-5.5 a3.5 3.5 0 0 1 3.5-3.5 z" />
      <path d="M9.6 12.2 L12 6.8 L14.4 12.2 M10.6 10.2 H13.4" />
    </svg>
  ),
  mic: (
    <svg width="56%" height="56%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5.5 11 v0.5 a6.5 6.5 0 0 0 13 0 V11" />
      <path d="M12 18 V21 M8.5 21 H15.5" />
    </svg>
  ),
  send: (
    <svg width="56%" height="56%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21.5 2.5 L2.5 9.6 L11 13 L14.4 21.5 Z" />
      <path d="M21.5 2.5 L11 13" />
    </svg>
  ),
  stop: (
    <svg width="50%" height="50%" viewBox="0 0 24 24">
      <rect x="4.5" y="4.5" width="15" height="15" rx="3.5" fill="currentColor" />
    </svg>
  ),
  sidepanel: (
    <svg width="46%" height="46%" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2.5 8 H9.5" />
      <path d="M7 5.5 L9.5 8 L7 10.5" />
      <path d="M13 3 V13" />
    </svg>
  ),
  edit: (
    <svg width="50%" height="50%" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter">
      <path d="M11.2 2.8 L13.2 4.8 L5.5 12.5 L2.8 13.2 L3.5 10.5 Z" />
      <path d="M9.7 4.3 L11.7 6.3" />
    </svg>
  ),
};

const VARIANT_BASE: Record<IconButtonVariant, string> = {
  default: "gsv-ibtn",
  floating: "gsv-ibtn-floating",
};

/** IconButton — ported from IconButton.dc.html. Square icon button with inline
 *  SVG glyphs, named or numeric size, disabled + title + onClick. `variant`
 *  selects the visual treatment (default filled / floating borderless). */
export function IconButton({ glyph = "back", size = "medium", disabled = false, variant = "default", ghost = false, className, title = "", ariaLabel, ariaDescribedBy, onClick, ...rest }: IconButtonProps) {
  const px = typeof size === "number" ? size : SIZE_MAP[size] ?? Number(size) ?? 30;
  const base = ghost ? "gsv-ibtn-ghost" : VARIANT_BASE[variant];
  // Disabled state reuses the base class plus is-disabled, except the legacy
  // default variant which has its own dedicated disabled class.
  const disabledCls = ghost || variant === "floating" ? `${base} is-disabled` : "gsv-ibtn-disabled";
  const cls = [disabled ? disabledCls : base, className].filter(Boolean).join(" ");
  const describedBy = ariaDescribedBy ?? rest["aria-describedby"];
  return (
    <button
      type="button"
      class={cls}
      title={title || undefined}
      aria-label={ariaLabel || title || undefined}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", width: `${px}px`, height: `${px}px` }}
    >
      {GLYPHS[glyph]}
    </button>
  );
}
