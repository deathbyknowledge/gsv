import type { ComponentChildren, JSX } from "preact";
import { Icon, type IconName } from "./Icon";

type ConsoleCardProps = {
  children: ComponentChildren;
  class?: string;
  selected?: boolean;
  tone?: "accent" | "good" | "warning" | "danger" | "neutral";
  onClick?: JSX.MouseEventHandler<HTMLButtonElement>;
};

export function ConsoleCard({
  children,
  class: className = "",
  selected = false,
  tone = "neutral",
  onClick,
}: ConsoleCardProps) {
  const classes = [
    "gsv-object-card",
    `is-${tone}`,
    selected ? "is-selected" : "",
    onClick ? "is-actionable" : "",
    className,
  ].filter(Boolean).join(" ");

  if (onClick) {
    return (
      <button type="button" class={classes} onClick={onClick}>
        {children}
      </button>
    );
  }

  return <article class={classes}>{children}</article>;
}

export function ObjectHeader({
  title,
  eyebrow,
  subtitle,
  icon = "user",
  tone = "neutral",
  status = "good",
  compact = false,
}: {
  title: string;
  eyebrow?: string;
  subtitle?: string;
  icon?: IconName;
  tone?: "accent" | "good" | "warning" | "danger" | "neutral";
  status?: "good" | "warning" | "danger" | "neutral";
  compact?: boolean;
}) {
  return (
    <header class={`gsv-object-header${compact ? " is-compact" : ""}`}>
      <div class="gsv-object-title">
        <div class="gsv-object-name-line">
          <strong>{title}</strong>
          {eyebrow ? <span>{eyebrow}</span> : null}
        </div>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      <div class={`gsv-object-avatar is-${tone}`} aria-hidden="true">
        <Icon name={icon} />
        <span class={`gsv-object-status is-${status}`}></span>
      </div>
    </header>
  );
}

export function DisclosureLine({
  label,
  detail,
  open = false,
  muted = false,
  tone = "neutral",
}: {
  label: string;
  detail?: ComponentChildren;
  open?: boolean;
  muted?: boolean;
  tone?: "good" | "warning" | "danger" | "neutral";
}) {
  return (
    <div class={`gsv-disclosure-line is-${tone}${muted ? " is-muted" : ""}`}>
      <span class={`gsv-disclosure-caret${open ? " is-open" : ""}`} aria-hidden="true"></span>
      <span class="gsv-disclosure-label">{label}</span>
      {detail ? <span class="gsv-disclosure-detail">{detail}</span> : null}
    </div>
  );
}

export function MetadataStack({ children }: { children: ComponentChildren }) {
  return <dl class="gsv-metadata-stack">{children}</dl>;
}

export function MetadataItem({ label, value }: { label: string; value: ComponentChildren }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
