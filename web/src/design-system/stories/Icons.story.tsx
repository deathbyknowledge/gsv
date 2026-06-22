import type { Story } from "../story";
import { DOTICONS } from "../doticons";

/**
 * Object icons. Two sets, both static SVG assets — no runtime JS icon module:
 *  · GSV's 16 curated object/chrome icons in /icons/<name>.svg (16-grid, generated
 *    from gsv-dot-icons.js).
 *  · The full doticons library (247 icons, 32-grid) vendored from
 *    eduardconstantin/doticons@v0.9.0 into /icons/doticons/<name>.svg, shown in the
 *    reference drawer below.
 * Each is applied as a CSS `mask-image` and tinted with a theme token, so a
 * black-filled source SVG still takes the color.
 */

const ICONS = [
  "bookmark", "chat", "cog", "computer", "discord", "folder", "gmail", "list",
  "pencil", "plus", "rss", "stars", "tag", "telegram", "terminal", "weblink",
];

function maskStyle(url: string, color: string, px: number) {
  return {
    width: `${px}px`,
    height: `${px}px`,
    backgroundColor: color,
    maskImage: url,
    WebkitMaskImage: url,
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    maskSize: "contain",
    WebkitMaskSize: "contain",
    maskPosition: "center",
    WebkitMaskPosition: "center",
  } as const;
}

function IconTile({ src, name, color, px }: { src: string; name: string; color: string; px: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px" }}>
      <div role="img" aria-label={name} style={maskStyle(`url(${src})`, color, px)} />
      <div class="ds-label" style={{ fontSize: "8.5px", letterSpacing: "0.1em", textAlign: "center" }}>
        {name}
      </div>
    </div>
  );
}

const story: Story = {
  title: "Object icons",
  group: "Foundations",
  blurb: "static dot-matrix SVGs · CSS mask tint · no runtime JS",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label" style={{ marginBottom: "16px" }}>
          GSV object & chrome icons · /icons/*.svg · tinted var(--accent-bright)
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(88px, 1fr))",
            gap: "22px",
            alignItems: "start",
          }}
        >
          {ICONS.map((name) => (
            <IconTile key={name} src={`/icons/${name}.svg`} name={name} color="var(--accent-bright)" px={40} />
          ))}
        </div>
      </div>

      {/* OTHER ICONS drawer — the full doticons library, vendored locally for reference. */}
      <div
        class="ds-cell"
        style={{ marginTop: "10px", paddingTop: "20px", borderTop: "1px solid var(--rule-section)" }}
      >
        <div class="ds-label" style={{ marginBottom: "4px" }}>
          Other icons · doticons library (32-grid · {DOTICONS.length} icons · reference)
        </div>
        <div style={{ fontSize: "9px", letterSpacing: "0.04em", color: "var(--text-dim)", marginBottom: "16px" }}>
          /icons/doticons/*.svg · vendored from eduardconstantin/doticons@v0.9.0 (MIT)
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))",
            gap: "16px",
            alignItems: "start",
          }}
        >
          {DOTICONS.map((name) => (
            <IconTile key={name} src={`/icons/doticons/${name}.svg`} name={name} color="var(--text-dim)" px={28} />
          ))}
        </div>
      </div>
    </div>
  ),
};

export default story;
