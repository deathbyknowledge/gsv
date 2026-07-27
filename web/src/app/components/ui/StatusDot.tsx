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

/** Status-label text color per tone, mirroring ListRow's treatment: idle stays
 *  dim (var(--meta)) rather than tinted; every other tone takes its own color. */
export const STATUS_TEXT: Record<StatusTone, string> = {
  online: "var(--online)",
  error: "var(--error)",
  idle: "var(--meta)",
  update: "var(--update)",
  live: "var(--live)",
  warn: "var(--warn)",
};

export interface StatusMetaProps {
  tone: StatusTone;
  label: string;
  /** Dot diameter in px. */
  dotSize?: number;
}

/** StatusMeta — a tone-colored status word with a leading StatusDot. The shared
 *  header-level status treatment: used in page headers and section-card headers
 *  so a status reads the same everywhere (and in step with the list rows). */
export function StatusMeta({ tone, label, dotSize = 7 }: StatusMetaProps) {
  return (
    <span
      class="gsv-status-meta gsv-sublabel"
      style={{ display: "inline-flex", alignItems: "center", gap: "8px", letterSpacing: ".16em", color: STATUS_TEXT[tone] }}
    >
      <StatusDot tone={tone} size={dotSize} />
      {label}
    </span>
  );
}
