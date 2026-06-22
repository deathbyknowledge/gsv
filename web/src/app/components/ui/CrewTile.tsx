import { AgentImage } from "./AgentImage";
import { Icon } from "./Icon";
import { StatusDot, type StatusTone } from "./StatusDot";
import "./CrewTile.css";

export interface CrewTileProps {
  active?: boolean;
  className?: string;
  imageIndex?: number;
  imageSrc?: string;
  name: string;
  onClick?: () => void;
  statusLabel?: string;
  tone?: StatusTone;
}

export interface CrewAddTileProps {
  className?: string;
  label?: string;
  onClick?: () => void;
}

function classNames(...parts: readonly (false | null | string | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function CrewTile({
  active = false,
  className,
  imageIndex,
  imageSrc,
  name,
  onClick,
  statusLabel = "IDLE",
  tone = "idle",
}: CrewTileProps) {
  const classes = classNames("gsv-crew-tile", active && "is-active", className);
  const content = (
    <>
      <span class="gsv-crew-tile-portrait">
        <AgentImage agent={imageIndex} src={imageSrc} size={54} />
      </span>
      <strong>{name}</strong>
      <span class="gsv-crew-tile-status">
        <StatusDot tone={tone} size={8} />
        {statusLabel}
      </span>
    </>
  );

  if (onClick) {
    return (
      <button type="button" class={classes} onClick={onClick}>
        {content}
      </button>
    );
  }

  return <div class={classes}>{content}</div>;
}

export function CrewAddTile({
  className,
  label = "NEW AGENT",
  onClick,
}: CrewAddTileProps) {
  const classes = classNames("gsv-crew-tile", "is-add", className);
  const content = (
    <>
      <span class="gsv-crew-tile-add-icon">
        <Icon name="plus" size={16} />
      </span>
      <strong>{label}</strong>
    </>
  );

  if (onClick) {
    return (
      <button type="button" class={classes} onClick={onClick}>
        {content}
      </button>
    );
  }

  return <div class={classes}>{content}</div>;
}
