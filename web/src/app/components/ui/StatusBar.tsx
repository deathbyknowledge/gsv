export interface StatusBarProps {
  model?: string;
  context?: string;
  clock?: string;
  power?: string;
  statusLabel?: string;
  statusTone?: "online" | "loading" | "offline" | "error";
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
 *  online indicator + model + context on the left, clock + power on the right. */
export function StatusBar({
  model = "GATEWAY DEFAULT",
  context = "CTX 50%",
  clock = "14:21:08",
  power = "SYNC",
  statusLabel = "GSV ONLINE",
  statusTone = "online",
}: StatusBarProps) {
  return (
    <div
      style={{
        height: "30px",
        background: "var(--node-bg)",
        borderTop: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 18px",
        fontFamily: "var(--gsv-font-mono)",
        fontSize: "10px",
        letterSpacing: ".14em",
        color: "var(--text-dim)",
      }}
    >
      <div style={{ display: "flex", gap: "22px", alignItems: "center" }}>
        <span style={{ color: statusColor(statusTone) }}>● {statusLabel}</span>
        <span>{model}</span>
        <span style={{ color: "#9a94ff" }}>{context}</span>
      </div>
      <div style={{ display: "flex", gap: "22px", alignItems: "center" }}>
        <span>{clock}</span>
        <span style={{ color: "#bbb6ff" }}>{"⏻ "}{power}</span>
      </div>
    </div>
  );
}
