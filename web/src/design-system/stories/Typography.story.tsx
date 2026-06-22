import type { Story } from "../story";

/**
 * Typography. Two faces, per the design system:
 *   · Departure Mono — the machine: labels, HUD, readouts (the type scale below).
 *   · Space Grotesk  — human prose: chat bubbles, section intros.
 * Both self-hosted in web/public/fonts/ (OFL). Scale values are transcribed from
 * the source design-system spec.
 */

interface Spec {
  name: string;
  weight: number;
  size: number; // px
  tracking: string; // em
  sample: string;
}

// Departure Mono machine scale (from the source: "Title 700/19/.14em", etc.)
const SCALE: Spec[] = [
  { name: "Title", weight: 700, size: 19, tracking: "0.14em", sample: "GENERAL SYSTEMS VEHICLE" },
  { name: "Section", weight: 600, size: 13.5, tracking: "0.2em", sample: "THE SHIP" },
  { name: "Sub-label", weight: 500, size: 10, tracking: "0.2em", sample: "HOSTS" },
  { name: "List item", weight: 400, size: 11, tracking: "0.04em", sample: "<hank-linux>" },
  { name: "Meta / HUD", weight: 400, size: 11, tracking: "0.32em", sample: "CONTEXT 50%" },
];

function Row({ spec }: { spec: Spec }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "150px 1fr",
        alignItems: "baseline",
        gap: "20px",
        padding: "14px 0",
        borderBottom: "1px solid var(--rule-inner)",
      }}
    >
      <div>
        <div style={{ fontSize: "11px", letterSpacing: "0.08em", color: "var(--text-title)" }}>{spec.name}</div>
        <div style={{ fontSize: "9px", letterSpacing: "0.06em", color: "var(--text-dim)", marginTop: "4px" }}>
          {spec.weight} · {spec.size}px · {spec.tracking}
        </div>
      </div>
      <div
        style={{
          fontFamily: "var(--gsv-font-mono)",
          fontWeight: spec.weight,
          fontSize: `${spec.size}px`,
          letterSpacing: spec.tracking,
          color: "var(--text-hi)",
        }}
      >
        {spec.sample}
      </div>
    </div>
  );
}

const story: Story = {
  title: "Typography",
  group: "Foundations",
  blurb: "Departure Mono (machine) + Space Grotesk (prose) · self-hosted, OFL",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Departure Mono · machine scale (labels · HUD · readouts)</div>
        <div style={{ marginTop: "6px" }}>
          {SCALE.map((s) => (
            <Row key={s.name} spec={s} />
          ))}
        </div>
      </div>

      <div class="ds-cell">
        <div class="ds-label">Space Grotesk · human prose (chat bubbles · section intros)</div>
        <p
          style={{
            fontFamily: "var(--gsv-font-prose)",
            fontWeight: 400,
            fontSize: "14px",
            lineHeight: 1.55,
            letterSpacing: "0.01em",
            color: "var(--text)",
            maxWidth: "56ch",
            margin: "12px 0 0",
          }}
        >
          Aye, captain. Opening a crew berth and wiring the new agent into the roster — it'll be
          ready to take orders in a moment.
        </p>
        <div
          style={{
            fontFamily: "var(--gsv-font-prose)",
            fontWeight: 700,
            fontSize: "20px",
            letterSpacing: "0.01em",
            color: "var(--text-hi)",
            marginTop: "14px",
          }}
        >
          The quick brown fox · 0123456789
        </div>
      </div>

      <div class="ds-cell">
        <div class="ds-label">Character set · Departure Mono</div>
        <div
          style={{
            fontFamily: "var(--gsv-font-mono)",
            fontSize: "15px",
            letterSpacing: "0.06em",
            color: "var(--text)",
            marginTop: "10px",
            lineHeight: 1.7,
          }}
        >
          ABCDEFGHIJKLMNOPQRSTUVWXYZ
          <br />
          abcdefghijklmnopqrstuvwxyz
          <br />
          0123456789 · !?@#$%&amp;*()[]&#123;&#125;/\&lt;&gt;
        </div>
      </div>
    </div>
  ),
};

export default story;
