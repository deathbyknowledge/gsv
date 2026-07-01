import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Story } from "../story";

/**
 * Typography. Two faces, per the design system:
 *   · Departure Mono — the machine: labels, HUD, readouts.
 *   · Space Grotesk  — human prose: chat bubbles, section intros, console flows.
 * Both self-hosted in web/public/fonts/ (OFL).
 *
 * SOURCE OF TRUTH: web/src/styles/gsv-type.css. Every row below renders its
 * sample with the real `.gsv-*` utility class and reads the *computed* size /
 * weight / tracking back off the element — so this page can never drift from
 * the live scale again. To change a tier, edit gsv-type.css; this doc follows.
 */

interface Tier {
  cls: string; // utility class, without the leading dot
  sample: string;
  note?: string; // when to reach for it
}

// Departure Mono — machine scale (labels · HUD · readouts), largest first.
const MONO: Tier[] = [
  { cls: "gsv-title", sample: "GENERAL SYSTEMS VEHICLE", note: "page + card titles" },
  { cls: "gsv-section", sample: "THE SHIP", note: "section headings" },
  { cls: "gsv-paragraph", sample: "Aye, captain — the roster is standing by for orders.", note: "mono running copy" },
  { cls: "gsv-listitem", sample: "<hank-linux>", note: "list rows, values" },
  { cls: "gsv-meta", sample: "CONTEXT 50%", note: "wide-tracked HUD readouts" },
  { cls: "gsv-paragraph-small", sample: "Dense mono copy where space is tight.", note: "compact mono copy" },
  { cls: "gsv-label", sample: "STANDBY", note: "control + object labels" },
  { cls: "gsv-sublabel", sample: "HOSTS", note: "non-primary chrome, eyebrows (sub-floor exception)" },
];

// Space Grotesk — human prose (chat, onboarding, console flows), largest first.
const PROSE: Tier[] = [
  { cls: "gsv-prose-display", sample: "General Systems Vehicle", note: "hero / display headings" },
  { cls: "gsv-prose-heading", sample: "Opening a crew berth", note: "prose headings" },
  { cls: "gsv-prose-lead", sample: "Wiring the new agent into the roster — ready in a moment.", note: "lead paragraphs" },
  { cls: "gsv-prose", sample: "Default body copy for running prose across the console flows.", note: "default body copy" },
  { cls: "gsv-prose-sm", sample: "Dense body copy and captions where the layout is tight.", note: "dense body / captions" },
];

function Row({ tier }: { tier: Tier }) {
  const ref = useRef<HTMLDivElement>(null);
  const [spec, setSpec] = useState("");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize) || 0;
    const ls = parseFloat(cs.letterSpacing) || 0; // px ("normal" → NaN → 0)
    const em = size ? Number((ls / size).toFixed(3)) : 0;
    const px = Math.round(size * 100) / 100;
    setSpec(`${cs.fontWeight} · ${px}px · ${em}em`);
  }, [tier.cls]);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "220px 1fr",
        alignItems: "baseline",
        gap: "20px",
        padding: "14px 0",
        borderBottom: "1px solid var(--rule-inner)",
      }}
    >
      <div>
        <div style={{ fontFamily: "var(--gsv-font-mono)", fontSize: "0.6875rem", letterSpacing: "0.04em", color: "var(--text-title)" }}>
          .{tier.cls}
        </div>
        <div style={{ fontFamily: "var(--gsv-font-mono)", fontSize: "0.625rem", letterSpacing: "0.04em", color: "var(--text-dim)", marginTop: "4px" }}>
          {spec}
        </div>
        {tier.note ? (
          <div style={{ fontFamily: "var(--gsv-font-prose)", fontSize: "0.75rem", color: "var(--meta)", marginTop: "4px" }}>{tier.note}</div>
        ) : null}
      </div>
      <div ref={ref} class={tier.cls} style={{ color: "var(--text-hi)", minWidth: 0, overflowWrap: "anywhere" }}>
        {tier.sample}
      </div>
    </div>
  );
}

const story: Story = {
  title: "Typography",
  group: "Foundations",
  blurb: "Departure Mono (machine) + Space Grotesk (prose) · self-hosted, OFL · live from gsv-type.css",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Departure Mono · machine scale (labels · HUD · readouts)</div>
        <div style={{ marginTop: "6px" }}>
          {MONO.map((t) => (
            <Row key={t.cls} tier={t} />
          ))}
        </div>
      </div>

      <div class="ds-cell">
        <div class="ds-label">Space Grotesk · human prose (chat bubbles · onboarding · console flows)</div>
        <div style={{ marginTop: "6px" }}>
          {PROSE.map((t) => (
            <Row key={t.cls} tier={t} />
          ))}
        </div>
      </div>

      <div class="ds-cell">
        <div class="ds-label">Character set · Departure Mono</div>
        <div
          style={{
            fontFamily: "var(--gsv-font-mono)",
            fontSize: "0.9375rem",
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
