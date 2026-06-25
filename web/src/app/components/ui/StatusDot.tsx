export type StatusTone = "online" | "error" | "idle" | "update" | "live" | "warn";

export interface StatusDotProps {
  tone?: StatusTone;
  /** Diameter in px (4–24). */
  size?: number;
  glow?: boolean;
}

const TONE_VAR: Record<StatusTone, string> = {
  online: "var(--online)",
  error: "var(--error)",
  idle: "var(--idle)",
  update: "var(--update)",
  live: "var(--live)",
  warn: "var(--warn)",
};

/** StatusDot — ported from StatusDot.dc.html. */
export function StatusDot({ tone = "online", size = 8, glow }: StatusDotProps) {
  const color = TONE_VAR[tone] ?? TONE_VAR.online;
  const showGlow = glow ?? tone !== "idle";
  return (
    <span
      style={{
        borderRadius: "50%",
        display: "inline-block",
        flex: "none",
        width: `${size}px`,
        height: `${size}px`,
        background: color,
        boxShadow: showGlow ? `0 0 7px ${color}` : "none",
      }}
    />
  );
}
