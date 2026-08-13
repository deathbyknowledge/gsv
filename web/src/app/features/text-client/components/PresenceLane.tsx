import "../textClient.css";

export type PresenceActivity = "idle" | "active" | "waiting";
export type PresenceMotion = "none" | "thinking" | "search" | "read" | "mutate" | "execute";

export interface PresenceLaneProps {
  primary: string;
  secondary?: string;
  lines?: readonly string[];
  activity?: PresenceActivity;
  motion?: PresenceMotion;
  ariaLive?: "off" | "polite";
  className?: string;
}

/** A quiet status lane for ambient process presence at the top of the client. */
export function PresenceLane({
  primary,
  secondary,
  lines,
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
      <span class="text-client-presence-rule" aria-hidden="true">
        <span class="text-client-presence-signal" />
      </span>
      <span class="text-client-presence-copy">
        {(lines?.length ? lines.slice(0, 4) : [primary]).map((line, index) => (
          <span class={index === 0 ? "text-client-presence-primary" : "text-client-presence-line"} key={`${index}:${line}`}>{line}</span>
        ))}
        {secondary ? <span class="text-client-presence-secondary">{secondary}</span> : null}
      </span>
    </div>
  );
}
