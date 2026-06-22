import type { Story } from "../story";

/**
 * Object icons. Static SVGs live in `web/public/icons/<name>.svg`, generated once
 * from the dot-matrix source — there is no runtime JS icon module. Each file uses
 * `fill="currentColor"` so it can be tinted; here we apply it as a CSS `mask-image`
 * and color it with a theme token via `background-color`.
 */

// Every unique icon name emitted to /public/icons (see INDEX.md).
const ICONS = [
  "bookmark",
  "chat",
  "cog",
  "computer",
  "discord",
  "folder",
  "gmail",
  "list",
  "pencil",
  "plus",
  "rss",
  "stars",
  "tag",
  "telegram",
  "terminal",
  "weblink",
];

// A few painted in other tokens to prove mask tinting picks up theme color.
const TINTS: Record<string, string> = {
  plus: "var(--online)",
  terminal: "var(--text-dim)",
};

function Icon({ name }: { name: string }) {
  const color = TINTS[name] ?? "var(--accent-bright)";
  const url = `url(/icons/${name}.svg)`;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "8px",
      }}
    >
      <div
        role="img"
        aria-label={name}
        style={{
          width: "40px",
          height: "40px",
          backgroundColor: color,
          maskImage: url,
          WebkitMaskImage: url,
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
          maskSize: "contain",
          WebkitMaskSize: "contain",
          maskPosition: "center",
          WebkitMaskPosition: "center",
        }}
      />
      <div class="ds-label" style={{ fontSize: "9.5px", letterSpacing: "0.18em" }}>
        {name}
      </div>
    </div>
  );
}

const story: Story = {
  title: "Object icons",
  group: "Foundations",
  blurb: "public/icons/*.svg · static dot-matrix · CSS mask tint, no runtime JS",
  render: () => (
    <div class="ds-cell">
      <div class="ds-label" style={{ marginBottom: "16px" }}>
        Tinted via mask-image + var(--accent-bright) · plus=online, terminal=text-dim
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
          <Icon key={name} name={name} />
        ))}
      </div>
    </div>
  ),
};

export default story;
