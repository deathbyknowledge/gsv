import type { Story } from "../story";
import { Icon, type DotIconMatrix, type IconFamily } from "../../app/components/ui/Icon";
import { DOTICONS } from "../doticons";

/**
 * Object icons. GSV uses static SVG masks for curated app icons and an
 * explicit doticons reference family for broader icon needs.
 */

const ICONS = [
  "bookmark", "chat", "cog", "computer", "discord", "folder", "gmail", "list",
  "pencil", "plus", "rss", "stars", "tag", "telegram", "terminal", "weblink",
];

const COMPARISON_ICONS = ["folder", "file", "chat", "stars", "terminal", "computer"];
const COMPARISON_SIZES = [14, 16, 18, 20, 24, 32];

function IconTile({
  name,
  color,
  px,
  family,
  dotMatrix,
  note,
}: {
  name: string;
  color: string;
  px: number;
  family?: IconFamily;
  dotMatrix?: DotIconMatrix;
  note?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px" }}>
      <Icon name={name} color={color} size={px} family={family} dotMatrix={dotMatrix} />
      <div class="ds-label" style={{ fontSize: "8.5px", letterSpacing: "0.1em", textAlign: "center" }}>
        {name}
      </div>
      {note ? (
        <div style={{ color: "var(--text-dim)", fontSize: "8px", letterSpacing: "0.08em", textAlign: "center" }}>{note}</div>
      ) : null}
    </div>
  );
}

const story: Story = {
  title: "Object icons",
  group: "Foundations",
  blurb: "static SVG masks · CSS mask tint · no runtime JS",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label" style={{ marginBottom: "16px" }}>
          GSV app icons · curated masks · tinted var(--accent-bright)
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
            <IconTile key={name} name={name} color="var(--accent-bright)" px={40} />
          ))}
        </div>
      </div>

      <div
        class="ds-cell"
        style={{ marginTop: "10px", paddingTop: "20px", borderTop: "1px solid var(--rule-section)" }}
      >
        <div class="ds-label" style={{ marginBottom: "4px" }}>
          Doticons auto master selection · 16-dot at 20px and under · 32-dot above
        </div>
        <div style={{ fontSize: "9px", letterSpacing: "0.04em", color: "var(--text-dim)", marginBottom: "16px" }}>
          Forced columns show the exact 16/32 art masters for comparison; auto is what the app uses.
        </div>
        <div style={{ display: "grid", gap: "18px" }}>
          {COMPARISON_SIZES.map((px) => (
            <div key={px} style={{ display: "grid", gap: "10px" }}>
              <div class="ds-label">{px}px</div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(86px, 1fr))",
                  gap: "14px",
                  alignItems: "start",
                }}
              >
                {COMPARISON_ICONS.map((name) => (
                  <IconTile key={`${px}:${name}:auto`} name={name} color="var(--accent-bright)" px={px} family="doticons" note="auto" />
                ))}
                <IconTile name="folder" color="var(--text-dim)" px={px} family="doticons" dotMatrix={16} note="forced 16" />
                <IconTile name="folder" color="var(--text-dim)" px={px} family="doticons" dotMatrix={32} note="forced 32" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* OTHER ICONS drawer — the full doticons library, vendored locally for reference. */}
      <div
        class="ds-cell"
        style={{ marginTop: "10px", paddingTop: "20px", borderTop: "1px solid var(--rule-section)" }}
      >
        <div class="ds-label" style={{ marginBottom: "4px" }}>
          Other icons · doticons library ({DOTICONS.length} icons · reference)
        </div>
        <div style={{ fontSize: "9px", letterSpacing: "0.04em", color: "var(--text-dim)", marginBottom: "16px" }}>
          /icons/doticons/16/*.svg and /icons/doticons/*.svg · vendored from eduardconstantin/doticons@v0.9.0 (MIT)
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
            <IconTile key={name} name={name} color="var(--text-dim)" px={28} family="doticons" />
          ))}
        </div>
      </div>
    </div>
  ),
};

export default story;
