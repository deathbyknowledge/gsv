import "./Button.css";

export type ButtonVariant = "primary" | "secondary" | "danger" | "dangerGhost" | "link";

export interface ButtonProps {
  variant?: ButtonVariant;
  label?: string;
  disabled?: boolean;
  onClick?: () => void;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "gsv-btn-primary",
  secondary: "gsv-btn-secondary",
  danger: "gsv-btn-danger",
  dangerGhost: "gsv-btn-dghost",
  link: "gsv-btn-link",
};

/** Button — ported from Button.dc.html. */
export function Button({ variant = "primary", label = "BUTTON", disabled = false, onClick }: ButtonProps) {
  const cls = `gsv-btn ${VARIANT_CLASS[variant]}${disabled ? " is-disabled" : ""}`;
  return (
    <button
      type="button"
      class={cls}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
    >
      {label}
      {variant === "link" ? (
        <svg width="8" height="11" viewBox="0 0 9 12">
          <path d="M0 0 L9 6 L0 12 Z" fill="currentColor" />
        </svg>
      ) : null}
    </button>
  );
}
