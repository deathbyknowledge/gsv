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
export function Button({ variant = "primary", tone, label, disabled = false, block = false, type = "button", onClick, dataAttrs, "aria-describedby": describedBy }: ButtonProps) {
  const t = useT();
  const toneClass = variant === "link" && tone ? ` is-tone-${tone}` : "";
  const cls = `gsv-btn ${VARIANT_CLASS[variant]}${toneClass}${block ? " gsv-btn-block" : ""}${disabled ? " is-disabled" : ""}`;
  return (
    <button
      {...dataAttrs}
      type={type}
      class={cls}
      disabled={disabled}
      aria-describedby={describedBy}
      onClick={disabled ? undefined : onClick}
    >
      <span class="gsv-btn-label">{label ?? t("ui.button.label")}</span>
    </button>
  );
}
