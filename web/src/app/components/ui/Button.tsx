import type { JSX } from "preact";
import { useT } from "../../i18n/locale";
import "./Button.css";

export type ButtonVariant = "primary" | "secondary" | "success" | "danger" | "dangerGhost" | "link";
export type ButtonLinkTone = "error" | "neutral" | "success" | "attention";

export interface ButtonProps {
  variant?: ButtonVariant;
  /** Colour tone for the link variant (default keeps the accent). Ignored elsewhere. */
  tone?: ButtonLinkTone;
  label?: string;
  disabled?: boolean;
  block?: boolean;
  type?: "button" | "submit";
  onClick?: () => void;
  /** Renders a real `<a href>` (external http(s) destinations open in a new
   *  tab) for a navigation that carries button weight. Ignored while disabled. */
  href?: string;
  /** Extra data-* attributes spread onto the root (e.g. focus markers). */
  dataAttrs?: Record<`data-${string}`, string | number | boolean>;
  /** Set by a wrapping tooltip (`Hint`) so the button announces its hint. */
  "aria-describedby"?: string;
}

const VARIANT_CLASS = {
  primary: "gsv-btn-primary",
  secondary: "gsv-btn-secondary",
  success: "gsv-btn-success",
  danger: "gsv-btn-danger",
  dangerGhost: "gsv-btn-dghost",
  link: "gsv-btn-link",
};

/** Button — ported from Button.dc.html. */
export function Button({ variant = "primary", tone, label, disabled = false, block = false, type = "button", onClick, href, dataAttrs, "aria-describedby": describedBy }: ButtonProps) {
  const t = useT();
  const toneClass = variant === "link" && tone ? ` is-tone-${tone}` : "";
  const cls = `gsv-btn ${VARIANT_CLASS[variant]}${toneClass}${block ? " gsv-btn-block" : ""}${disabled ? " is-disabled" : ""}`;
  const content = (
    <>
      <span class="gsv-btn-label">{label ?? t("ui.button.label")}</span>
      {variant === "link" ? (
        <svg width="8" height="11" viewBox="0 0 9 12">
          <path d="M0 0 L9 6 L0 12 Z" fill="currentColor" />
        </svg>
      ) : null}
    </>
  );
  if (href && !disabled) {
    const external = /^https?:\/\//i.test(href);
    // A disabled fieldset does not reach anchors, so the link-button goes inert
    // itself: Enter and click do nothing while an enclosing fieldset is disabled
    // (Button.css greys it out alongside the fieldset's real controls).
    const onAnchorClick = (event: JSX.TargetedMouseEvent<HTMLAnchorElement>) => {
      if (event.currentTarget.closest("fieldset:disabled")) {
        event.preventDefault();
        return;
      }
      onClick?.();
    };
    return (
      <a
        {...dataAttrs}
        class={cls}
        href={href}
        aria-describedby={describedBy}
        onClick={onAnchorClick}
        {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
      >
        {content}
      </a>
    );
  }
  return (
    <button
      {...dataAttrs}
      type={type}
      class={cls}
      disabled={disabled}
      aria-describedby={describedBy}
      onClick={disabled ? undefined : onClick}
    >
      {content}
    </button>
  );
}
