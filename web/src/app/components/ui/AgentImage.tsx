export interface AgentImageProps {
  /** Crew index 0–2 → /img/agent-<n>.png. Ignored if `src` is provided. */
  agent?: number;
  /** Explicit image src; wins over `agent`. */
  src?: string;
  /** Box diameter in px (28–80). */
  size?: number;
}

/** AgentImage — ported from AgentImage.dc.html. Pixel crew portrait in a
 *  rounded, glowing tile. Size buckets keep the portrait crisp at any scale. */
export function AgentImage({ agent, src, size = 50 }: AgentImageProps) {
  const sz = Number(size) || 50;
  // agent index → raster portrait; explicit src wins
  const idx = agent === undefined || agent === null ? null : Number(agent) || 0;
  const imgSrc = src ?? (idx === null ? "/img/agent-0.png" : `/img/agent-${idx}.png`);
  // size buckets keep the pixel portrait crisp at every usage scale
  const fill = sz <= 44 ? 0.74 : sz <= 60 ? 0.68 : 0.62;
  const imgH = Math.round(sz * fill);
  const radius = sz <= 44 ? 3 : 4;
  const glow = sz <= 44 ? 5 : sz <= 60 ? 6 : 8;

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: `${sz}px`,
        height: `${sz}px`,
        borderRadius: `${radius}px`,
        background: "#171436",
        border: "1px solid var(--border)",
        overflow: "hidden",
        flex: "none",
      }}
    >
      <img
        src={imgSrc}
        alt="agent"
        style={{
          height: `${imgH}px`,
          imageRendering: "pixelated",
          filter: `drop-shadow(0 0 ${glow}px rgba(150,140,255,.4))`,
        }}
      />
    </div>
  );
}
