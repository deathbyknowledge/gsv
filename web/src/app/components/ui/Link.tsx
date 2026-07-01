import type { ComponentChildren } from "preact";
import "./Link.css";

export interface LinkProps {
  href: string;
  children: ComponentChildren;
  /** Open in a new tab with a safe `rel`. Defaults to true for http(s) URLs. */
  external?: boolean;
  /** Render a trailing arrow glyph (for "read more"-style links). */
  arrow?: boolean;
  className?: string;
  onClick?: () => void;
}

/** Link — the design system's text link / anchor primitive. Token-styled
 *  (accent colour + underline rule, focus-visible ring) and, unlike
 *  `Button variant="link"`, it is a real `<a href>` so external destinations,
 *  middle-click, and right-click "open in new tab" all behave natively. */
export function Link({ href, children, external, arrow = false, className = "", onClick }: LinkProps) {
  const isExternal = external ?? /^https?:\/\//i.test(href);
  const cls = ["gsv-link", "gsv-listitem", className].filter(Boolean).join(" ");

  return (
    <a
      class={cls}
      href={href}
      onClick={onClick}
      {...(isExternal ? { target: "_blank", rel: "noreferrer noopener" } : {})}
    >
      <span class="gsv-link-label">{children}</span>
      {arrow ? <span class="gsv-link-arrow" aria-hidden="true">→</span> : null}
    </a>
  );
}
