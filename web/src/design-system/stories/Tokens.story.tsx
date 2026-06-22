import type { Story } from "../story";

interface Swatch {
  name: string;
  varName: string;
  value: string;
}

const SURFACES: Swatch[] = [
  { name: "void", varName: "--void", value: "#07061a" },
  { name: "panel", varName: "--panel", value: "#0a0820" },
  { name: "panel-2", varName: "--panel-2", value: "#0a0822" },
  { name: "node-bg", varName: "--node-bg", value: "#0b0a1e" },
  { name: "header-bar", varName: "--header-bar", value: "#13112e" },
  { name: "frame-lo", varName: "--frame-lo", value: "#08061c" },
  { name: "frame-hi", varName: "--frame-hi", value: "#161240" },
];
const LINES: Swatch[] = [
  { name: "border", varName: "--border", value: "#322e74" },
  { name: "border-raised", varName: "--border-raised", value: "#4a449e" },
  { name: "rule-inner", varName: "--rule-inner", value: "#25224d" },
  { name: "rule-section", varName: "--rule-section", value: "#3a3676" },
  { name: "bracket", varName: "--bracket", value: "#6b66c4" },
  { name: "dashed", varName: "--dashed", value: "#5a52a8" },
];
const TEXT: Swatch[] = [
  { name: "text-hi", varName: "--text-hi", value: "#f4f2ff" },
  { name: "text", varName: "--text", value: "#efeefe" },
  { name: "text-title", varName: "--text-title", value: "#e2dfff" },
  { name: "accent", varName: "--accent", value: "#b3aeff" },
  { name: "accent-bright", varName: "--accent-bright", value: "#cbc7ff" },
  { name: "label", varName: "--label", value: "#b3aee2" },
  { name: "node-label", varName: "--node-label", value: "#c4bfee" },
  { name: "text-dim", varName: "--text-dim", value: "#565199" },
];
const STATUS: Swatch[] = [
  { name: "online", varName: "--online", value: "#5ef2a0" },
  { name: "error", varName: "--error", value: "#ff6f8c" },
  { name: "idle", varName: "--idle", value: "#6661a0" },
  { name: "update", varName: "--update", value: "#ffd24d" },
  { name: "live", varName: "--live", value: "#8f8aff" },
];
const ACTION: Swatch[] = [
  { name: "primary-hi", varName: "--primary-hi", value: "#6b62c4" },
  { name: "danger", varName: "--danger", value: "#a8324a" },
  { name: "danger-hi", varName: "--danger-hi", value: "#c4445f" },
  { name: "warn", varName: "--warn", value: "#e0a64c" },
];

function SwatchGrid({ label, swatches }: { label: string; swatches: Swatch[] }) {
  return (
    <div class="ds-cell" style={{ marginBottom: "22px" }}>
      <div class="ds-label">{label}</div>
      <div class="ds-swatches">
        {swatches.map((s) => (
          <div class="ds-swatch" key={s.varName}>
            <div class="ds-swatch-chip" style={{ background: `var(${s.varName})` }} />
            <div class="ds-swatch-meta">
              <div class="ds-swatch-name">{s.name}</div>
              <div class="ds-swatch-val">
                {s.varName} · {s.value}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const story: Story = {
  title: "Color tokens",
  group: "Foundations",
  blurb: "gsv-tokens.css · single source of truth",
  render: () => (
    <div>
      <SwatchGrid label="Surfaces" swatches={SURFACES} />
      <SwatchGrid label="Borders & rules" swatches={LINES} />
      <SwatchGrid label="Text & accent" swatches={TEXT} />
      <SwatchGrid label="Status" swatches={STATUS} />
      <SwatchGrid label="Action accents" swatches={ACTION} />
      <div class="ds-type-spec ds-type-row" style={{ marginTop: "10px" }}>
        <div class="ds-label">Typography · Departure Mono (self-hosted, OFL 1.1)</div>
        <div style={{ fontSize: "28px", letterSpacing: "0.04em", color: "var(--text-hi)" }}>
          GENERAL SYSTEMS VEHICLE
        </div>
        <div style={{ fontSize: "16px", letterSpacing: "0.1em", color: "var(--text)", marginTop: "8px" }}>
          0123456789 · the quick brown fox · ABCDEFG
        </div>
        <div style={{ fontSize: "10px", letterSpacing: "0.22em", color: "var(--text-dim)", marginTop: "8px" }}>
          MICRO LABEL · 9.5PX · .22EM TRACKING
        </div>
      </div>
    </div>
  ),
};

export default story;
