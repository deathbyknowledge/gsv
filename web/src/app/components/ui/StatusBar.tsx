export interface StatusBarProps {
  model?: string;
  context?: string;
  clock?: string;
  power?: string;
  /** Tone for the `power` readout. When set, the power word takes its status
   *  color; otherwise it keeps the neutral lavender. */
  powerTone?: "online" | "loading" | "offline" | "error";
  statusLabel?: string;
  statusTone?: "online" | "loading" | "offline" | "error";
  /** When set, the bar renders this single line as its content instead of the
   *  model/context/clock/power layout. */
  label?: string;
  /** Horizontal alignment of the bar content. Defaults to "between" for the
   *  system readout and "center" when a `label` is provided. */
  align?: "between" | "center";
  showModel?: boolean;
  showStatus?: boolean;
}

function statusColor(tone: NonNullable<StatusBarProps["statusTone"]>): string {
  if (tone === "error") {
    return "var(--error)";
  }
  if (tone === "offline") {
    return "var(--idle)";
  }
  if (tone === "loading") {
    return "var(--update)";
  }
  return "var(--bracket)";
}

/** StatusBar — ported from StatusBar.dc.html. Bottom system status strip:
 *  online indicator + model + context on the left, clock + power on the right.
 *  When `label` is provided, renders that single line as the bar's content. */
export function StatusBar({
  model = "GATEWAY DEFAULT",
  context = "CTX 50%",
  clock = "14:21:08",
  power = "SYNC",
  powerTone,
  statusLabel = "GSV ONLINE",
  statusTone = "online",
  label,
  align,
  showModel = true,
  showStatus = true,
}: StatusBarProps) {
  const justify =
    (align ?? (label != null ? "center" : "between")) === "center"
      ? "center"
      : "space-between";

  return (
    <div
      class="gsv-sublabel"
      style={{
        height: "30px",
        background: "var(--node-bg)",
        borderTop: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: justify,
        padding: "0 18px",
        // font-family + size (10px) from .gsv-sublabel; tracking kept as inline override
        letterSpacing: ".14em",
        color: "var(--text-dim)",
      }}
    >
      {label != null ? (
        <span>{label}</span>
      ) : (
        <>
          <div style={{ display: "flex", gap: "22px", alignItems: "center" }}>
            {showStatus ? <span style={{ color: statusColor(statusTone) }}>● {statusLabel}</span> : null}
            {showModel ? <span>{model}</span> : null}
            <span style={{ color: "#9a94ff" }}>{context}</span>
          </div>
          <div style={{ display: "flex", gap: "22px", alignItems: "center" }}>
            <span>{clock}</span>
            <span style={{ color: powerTone ? statusColor(powerTone) : "#bbb6ff" }}>{"⏻ "}{power}</span>
          </div>
        </>
      )}
    </div>
  );
}
