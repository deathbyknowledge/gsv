import "./Button.css";

export type ButtonVariant = "primary" | "secondary" | "danger" | "dangerGhost" | "link";

export interface ButtonProps {
  variant?: ButtonVariant;
  label?: string;
  disabled?: boolean;
  block?: boolean;
  type?: "button" | "submit";
  onClick?: () => void;
  /** Extra data-* attributes spread onto the root (e.g. focus markers). */
  dataAttrs?: Record<`data-${string}`, string | number | boolean>;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "gsv-btn-primary",
  secondary: "gsv-btn-secondary",
  danger: "gsv-btn-danger",
  dangerGhost: "gsv-btn-dghost",
  link: "gsv-btn-link",
};

/** Button — ported from Button.dc.html. */
export function Button({ variant = "primary", label = "BUTTON", disabled = false, block = false, type = "button", onClick, dataAttrs }: ButtonProps) {
  const cls = `gsv-btn ${VARIANT_CLASS[variant]}${block ? " gsv-btn-block" : ""}${disabled ? " is-disabled" : ""}`;
  return (
    <button
      {...dataAttrs}
      type={type}
      class={cls}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
    >
      <span class="gsv-btn-label">{label}</span>
      {variant === "link" ? (
        <svg width="8" height="11" viewBox="0 0 9 12">
          <path d="M0 0 L9 6 L0 12 Z" fill="currentColor" />
        </svg>
      ) : null}
    </button>
  );
}
