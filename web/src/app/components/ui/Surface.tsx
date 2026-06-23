import type { ComponentChildren } from "preact";
import "./Surface.css";

export interface SurfaceProps {
  /** Elevation: higher = lighter background + stronger shadow/border. */
  level?: 0 | 1 | 2;
  /** Adds a hover lift (raised bg + border). Use for clickable cards. */
  interactive?: boolean;
  /** Accent border + faint accent fill + glow — for selectable cards. */
  selected?: boolean;
  /** Element to render. Use "button" for clickable cards. */
  as?: "div" | "button";
  onClick?: () => void;
  /** Extra classes appended to the surface. */
  class?: string;
  /** Extra data-* attributes spread onto the root (e.g. focus markers). */
  dataAttrs?: Record<`data-${string}`, string | number | boolean>;
  children?: ComponentChildren;
}

/** Surface — reusable card/panel with consistent elevation, border and
 *  background across the GSV design system. */
export function Surface({
  level = 1,
  interactive = false,
  selected = false,
  as = "div",
  onClick,
  class: extraClass,
  dataAttrs,
  children,
}: SurfaceProps) {
  const cls = [
    "gsv-surface",
    `gsv-surface-l${level}`,
    interactive ? "is-interactive" : "",
    selected ? "is-selected" : "",
    extraClass ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  if (as === "button") {
    return (
      <button {...dataAttrs} type="button" class={cls} onClick={onClick}>
        {children}
      </button>
    );
  }
  return (
    <div {...dataAttrs} class={cls} onClick={onClick}>
      {children}
    </div>
  );
}
