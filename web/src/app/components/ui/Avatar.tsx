import { AgentImage } from "./AgentImage";

export type AvatarStatus = "online" | "idle" | "error" | "live";

export interface AvatarProps {
  /** Crew index 0–2 → /img/agent-<n>.png. Ignored if `src` is provided. */
  agent?: number;
  /** Explicit image src; wins over `agent`. */
  src?: string;
  /** Box diameter in px (28–80). */
  size?: number;
  /** Corner status dot. */
  status?: AvatarStatus;
  /** Fill the tile edge-to-edge instead of the padded pixel-art float. */
  cover?: boolean;
}

const DOT_COLOR: Record<AvatarStatus, string> = {
  online: "var(--online)",
  idle: "var(--idle)",
  error: "var(--error)",
  live: "var(--live)",
};

/** Avatar — ported from Avatar.dc.html. Wraps AgentImage and overlays a
 *  status corner-dot. */
export function Avatar({ agent, src, size = 44, status = "online", cover = false }: AvatarProps) {
  const dotColor = DOT_COLOR[status] ?? DOT_COLOR.online;
  const dotGlow = status === "idle" ? "none" : `0 0 7px ${dotColor}`;

  return (
    <div style={{ position: "relative", display: "inline-flex" }}>
      <AgentImage agent={agent} src={src} size={size} cover={cover} />
      <span
        style={{
          position: "absolute",
          top: "-3px",
          right: "-3px",
          width: "11px",
          height: "11px",
          borderRadius: "50%",
          background: dotColor,
          border: "2px solid #171436",
          boxShadow: dotGlow,
          zIndex: 1,
        }}
      />
    </div>
  );
}
