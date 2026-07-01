import { useLayoutEffect, useState } from "preact/hooks";
import type { Story } from "../story";

/**
 * SOURCE OF TRUTH: web/src/styles/gsv-tokens.css. Each swatch names a token and
 * reads its *computed* value off :root, so the printed hex can never drift from
 * the chip (which fills from the same var). Edit gsv-tokens.css; this follows.
 */

interface Swatch {
  name: string;
  varName: string;
}

const SURFACES: Swatch[] = [
  { name: "void", varName: "--void" },
  { name: "panel", varName: "--panel" },
  { name: "panel-2", varName: "--panel-2" },
  { name: "node-bg", varName: "--node-bg" },
  { name: "header-bar", varName: "--header-bar" },
  { name: "frame-lo", varName: "--frame-lo" },
  { name: "frame-hi", varName: "--frame-hi" },
];
const LINES: Swatch[] = [
  { name: "border", varName: "--border" },
  { name: "border-raised", varName: "--border-raised" },
  { name: "rule-inner", varName: "--rule-inner" },
  { name: "rule-section", varName: "--rule-section" },
  { name: "bracket", varName: "--bracket" },
  { name: "dashed", varName: "--dashed" },
];
const TEXT: Swatch[] = [
  { name: "text-hi", varName: "--text-hi" },
  { name: "text", varName: "--text" },
  { name: "text-title", varName: "--text-title" },
  { name: "accent", varName: "--accent" },
  { name: "accent-bright", varName: "--accent-bright" },
  { name: "label", varName: "--label" },
  { name: "node-label", varName: "--node-label" },
  { name: "text-muted", varName: "--text-muted" },
  { name: "prose-dim", varName: "--prose-dim" },
  { name: "meta", varName: "--meta" },
  { name: "text-dim", varName: "--text-dim" },
];
const STATUS: Swatch[] = [
  { name: "online", varName: "--online" },
  { name: "error", varName: "--error" },
  { name: "idle", varName: "--idle" },
  { name: "update", varName: "--update" },
  { name: "live", varName: "--live" },
];
const ACTION: Swatch[] = [
  { name: "primary-hi", varName: "--primary-hi" },
  { name: "danger", varName: "--danger" },
  { name: "danger-hi", varName: "--danger-hi" },
  { name: "warn", varName: "--warn" },
];

function tokenValue(varName: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

function SwatchCell({ swatch }: { swatch: Swatch }) {
  const [value, setValue] = useState("");
  useLayoutEffect(() => setValue(tokenValue(swatch.varName)), [swatch.varName]);
  return (
    <div class="ds-swatch">
      <div class="ds-swatch-chip" style={{ background: `var(${swatch.varName})` }} />
      <div class="ds-swatch-meta">
        <div class="ds-swatch-name">{swatch.name}</div>
        <div class="ds-swatch-val">
          {swatch.varName} · {value}
        </div>
      </div>
    </div>
  );
}

function SwatchGrid({ label, swatches }: { label: string; swatches: Swatch[] }) {
  return (
    <div class="ds-cell" style={{ marginBottom: "22px" }}>
      <div class="ds-label">{label}</div>
      <div class="ds-swatches">
        {swatches.map((s) => (
          <SwatchCell key={s.varName} swatch={s} />
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
    </div>
  ),
};

export default story;
