import type { ComponentChildren } from "preact";
import "./Surface.css";

export interface SurfaceProps {
  /** Removes card chrome while keeping the shared reset/interactive behavior. */
  flush?: boolean;
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
  children?: ComponentChildren;
}

/** Surface — reusable card/panel with consistent elevation, border and
 *  background across the GSV design system. */
export function Surface({
  flush = false,
  level = 1,
  interactive = false,
  selected = false,
  as = "div",
  onClick,
  class: extraClass,
  children,
}: SurfaceProps) {
  const cls = [
    "gsv-surface",
    `gsv-surface-l${level}`,
    flush ? "is-flush" : "",
    interactive ? "is-interactive" : "",
    selected ? "is-selected" : "",
    extraClass ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  if (as === "button") {
    return (
      <button type="button" class={cls} onClick={onClick}>
        {children}
      </button>
    );
  }
  return (
    <div class={cls} onClick={onClick}>
      {children}
    </div>
  );
}
