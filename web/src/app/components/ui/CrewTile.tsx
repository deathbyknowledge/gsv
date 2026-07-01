import { AgentImage } from "./AgentImage";
import { Icon } from "./Icon";
import { StatusDot, type StatusTone } from "./StatusDot";
import "./CrewTile.css";

export interface CrewTileProps {
  active?: boolean;
  className?: string;
  /** Fill the portrait tile edge-to-edge (full-frame portrait). */
  cover?: boolean;
  imageIndex?: number;
  imageSrc?: string;
  name: string;
  onClick?: () => void;
  statusLabel?: string;
  tone?: StatusTone;
}

export interface CrewAddTileProps {
  className?: string;
  description?: string;
  label?: string;
  onClick?: () => void;
}

function classNames(...parts: readonly (false | null | string | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function CrewTile({
  active = false,
  className,
  cover = false,
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
        <AgentImage agent={imageIndex} src={imageSrc} size={54} cover={cover} />
      </span>
      <strong>{name}</strong>
      <span class="gsv-crew-tile-status gsv-sublabel">
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
  description = "",
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
      {description ? <small class="gsv-crew-tile-description gsv-sublabel">{description}</small> : null}
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
