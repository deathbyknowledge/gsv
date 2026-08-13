import "../textClient.css";

export type PresenceActivity = "idle" | "active" | "waiting";
export type PresenceMotion = "none" | "thinking" | "search" | "read" | "mutate" | "execute";

export interface PresenceLaneProps {
  primary: string;
  secondary?: string;
  lines?: readonly string[];
  lineMotions?: readonly PresenceMotion[];
  activity?: PresenceActivity;
  motion?: PresenceMotion;
  ariaLive?: "off" | "polite";
  className?: string;
}

/** A quiet, unframed status lane matching the native client's process presence. */
export function PresenceLane({
  primary,
  secondary,
  lines,
  lineMotions,
  activity = "idle",
  motion = "none",
  ariaLive = "polite",
  className,
}: PresenceLaneProps) {
  const classes = [
    "text-client-presence-lane",
    `is-${activity}`,
    `motion-${motion}`,
    className,
  ].filter(Boolean).join(" ");

  return (
    <div
      class={classes}
      role="status"
      aria-live={ariaLive}
      aria-atomic="true"
    >
      <span class="text-client-presence-copy">
        {(lines?.length ? lines.slice(0, 4) : [primary]).map((line, index) => (
          <span class={`text-client-presence-line motion-${lineMotions?.[index] ?? motion}`} key={`${index}:${line}`}>
            <span class="text-client-presence-indicator" aria-hidden="true" />
            <span>{line}</span>
          </span>
        ))}
      </span>
      {secondary ? <span class="text-client-presence-secondary">{secondary}</span> : null}
    </div>
  );
}
