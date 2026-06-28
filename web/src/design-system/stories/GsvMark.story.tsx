import type { ComponentChildren } from "preact";
import type { Story } from "../story";
import { GsvMark, type GsvMarkVariant } from "../../app/components/ui/GsvMark";

/**
 * GSV Mark — the ship brand glyph. A pixel-art SVG rendered as an image so its
 * multi-tone palette is preserved. The `white` variant rides the dark rail, the
 * full-color `master` is the desktop mark, and `favicon` is the browser icon.
 */

function Swatch({
  label,
  light,
  children,
}: {
  label: string;
  light?: boolean;
  children: ComponentChildren;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "132px",
          height: "132px",
          border: "1px solid var(--border)",
          borderRadius: "4px",
          background: light ? "#e9e7ff" : "var(--void)",
        }}
      >
        {children}
      </div>
      <div class="ds-label" style={{ fontSize: "8.5px", textAlign: "center" }}>
        {label}
      </div>
    </div>
  );
}

const SIZE_RAMP = [16, 22, 32, 48, 64];

function SizeRow({ variant }: { variant: GsvMarkVariant }) {
  return (
    <div style={{ display: "flex", gap: "20px", alignItems: "flex-end", flexWrap: "wrap" }}>
      {SIZE_RAMP.map((s) => (
        <div key={s} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px" }}>
          <GsvMark variant={variant} size={s} />
          <div class="ds-label" style={{ fontSize: "8px" }}>{s}px</div>
        </div>
      ))}
    </div>
  );
}

const story: Story = {
  title: "GSV Mark",
  group: "Foundations",
  blurb: "ship brand glyph · white (rail) · full-color (desktop) · favicon",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label" style={{ marginBottom: "16px" }}>
          Variants · pixel-art SVG · rendered as an image (multi-tone, not tinted)
        </div>
        <div style={{ display: "flex", gap: "20px", flexWrap: "wrap" }}>
          <Swatch label="WHITE · RAIL">
            <GsvMark variant="white" size={72} />
          </Swatch>
          <Swatch label="FULL-COLOR · DESKTOP">
            <GsvMark variant="master" size={72} />
          </Swatch>
          <Swatch label="FAVICON">
            <GsvMark variant="favicon" size={72} />
          </Swatch>
          <Swatch label="FULL-COLOR · LIGHT BG" light>
            <GsvMark variant="master" size={72} />
          </Swatch>
        </div>
      </div>

      <div
        class="ds-cell"
        style={{ marginTop: "10px", paddingTop: "20px", borderTop: "1px solid var(--rule-section)" }}
      >
        <div class="ds-label" style={{ marginBottom: "16px" }}>
          White · size ramp (rail uses 22px)
        </div>
        <SizeRow variant="white" />
      </div>

      <div
        class="ds-cell"
        style={{ marginTop: "10px", paddingTop: "20px", borderTop: "1px solid var(--rule-section)" }}
      >
        <div class="ds-label" style={{ marginBottom: "16px" }}>
          Full-color · size ramp (desktop uses 50px)
        </div>
        <SizeRow variant="master" />
      </div>
    </div>
  ),
};

export default story;
