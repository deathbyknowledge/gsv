import type { JSX } from "preact";
import { Icon, type IconName } from "./Icon";

type ActionButtonProps = Omit<JSX.HTMLAttributes<HTMLButtonElement>, "size" | "icon"> & {
  icon?: IconName;
  label: string;
  busyLabel?: string;
  busy?: boolean;
  variant?: "default" | "primary" | "danger" | "ghost";
  size?: "icon" | "compact" | "full";
  // preact's generic HTMLAttributes does not carry button-specific attributes.
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
};

export function ActionButton({
  icon,
  label,
  busyLabel,
  busy = false,
  variant = "default",
  size,
  class: className = "",
  disabled,
  title,
  type = "button",
  ...props
}: ActionButtonProps) {
  const text = busy && busyLabel ? busyLabel : label;
  const resolvedSize = size ?? (icon ? "icon" : "compact");
  const iconOnly = resolvedSize === "icon";
  const classes = [
    "gsv-action-control",
    `is-${variant}`,
    `is-${resolvedSize}`,
    className,
  ].filter(Boolean).join(" ");

  return (
    <button
      {...props}
      type={type}
      class={classes}
      disabled={disabled || busy}
      title={title ?? label}
      aria-label={iconOnly ? text : props["aria-label"] ?? undefined}
    >
      {icon ? <Icon name={icon} /> : null}
      <span class={iconOnly ? "gsv-visually-hidden" : "gsv-action-control-label"}>{text}</span>
    </button>
  );
}
