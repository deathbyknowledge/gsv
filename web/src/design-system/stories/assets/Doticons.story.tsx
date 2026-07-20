import type { Story } from "../../story";
import { MaskTile, type AssetEntry } from "./tiles";
import "../../assets.css";

/**
 * Doticon assets — the two size masters shipped in web/public/icons/doticons/
 * (root = 32-dot art, 16/ = 16-dot art). Files are referenced directly by URL
 * path, enumerated from what's on disk — deliberately NOT imported from
 * doticons.ts (owned by a concurrent cleanup).
 *
 * `used` flags are from a manual grep audit (2026-07-13) of web/src,
 * index.html, manifest.webmanifest, and gsv-service-worker.js. A doticon file
 * is only ever requested through Icon's doticons family (`family="doticons"`,
 * a `name="doticons/…"` literal, or a direct `/icons/doticons/…` src) — app
 * names like `icon="cog"` resolve to the ROOT /icons set, not these files,
 * and Icon's DOTICON_ALIAS keys never fire outside the doticons family.
 * References only from the design-system catalog itself count as UNUSED.
 */

// Names with no live app usage (both size sets unless noted below).
const UNUSED_DOTICONS = new Set([
  "arrowRight",
  "box", // applicationConnectMock's icon="box" renders via the gsv family, not this file
  "chat", // app "chat" icon is the root /icons/chat.svg
  "circleDots",
  "circlePlus", // alias target for add/plus, but nothing calls it under the doticons family
  "cog", // app "cog" icon is the root /icons/cog.svg
  "powershell", // alias target for terminal, never fired
  "satellite", // app "satellite" icon is the root /icons/satellite.svg
  "stars", // app "stars" icon is the root /icons/stars.svg
  "wifi", // root set only; absent from the 16 set
]);

// On-disk enumeration: web/public/icons/doticons/*.svg (default 32-dot set).
const DOTICONS_ROOT = [
  "apple", "arrowRight", "box", "branch", "camera", "chat", "chrome",
  "circleDots", "circlePause", "circlePlay", "circlePlus", "close", "cog",
  "file", "folder", "messenger", "microphone", "pencil", "powershell",
  "redhat", "satellite", "stars", "volume", "weblink", "wifi", "windows",
];

// On-disk enumeration: web/public/icons/doticons/16/*.svg (16-dot set).
// Differs from root: has vimeo (used by ChatMediaAttachment video kind),
// lacks wifi.
const DOTICONS_16 = [
  "apple", "arrowRight", "box", "branch", "camera", "chat", "chrome",
  "circleDots", "circlePause", "circlePlay", "circlePlus", "close", "cog",
  "file", "folder", "messenger", "microphone", "pencil", "powershell",
  "redhat", "satellite", "stars", "vimeo", "volume", "weblink", "windows",
];

function entries(names: readonly string[], dir: string): AssetEntry[] {
  return names.map((name) => ({
    path: `${dir}/${name}.svg`,
    name,
    used: !UNUSED_DOTICONS.has(name),
  }));
}

const ROOT_ASSETS = entries(DOTICONS_ROOT, "/icons/doticons");
const SIXTEEN_ASSETS = entries(DOTICONS_16, "/icons/doticons/16");

const story: Story = {
  title: "Doticons",
  group: "Assets",
  blurb: "dot-matrix icon masters · 32-dot root set + 16-dot set · UNUSED badges from grep audit",
  render: () => (
    <div class="ds-col">
      <div class="as-section">
        <div class="ds-label" style={{ marginBottom: "4px" }}>
          /icons/doticons · default 32-dot masters ({ROOT_ASSETS.length} files)
        </div>
        <div style={{ fontSize: "9px", letterSpacing: "0.04em", color: "var(--text-dim)", marginBottom: "14px" }}>
          Requested when the doticons family renders above 20px. Tinted masks: accent = used, dim + badge = unused.
        </div>
        <div class="as-grid">
          {ROOT_ASSETS.map((asset) => (
            <MaskTile key={asset.path} asset={asset} size={32} />
          ))}
        </div>
      </div>

      <div class="as-section">
        <div class="ds-label" style={{ marginBottom: "4px" }}>
          /icons/doticons/16 · 16-dot masters ({SIXTEEN_ASSETS.length} files)
        </div>
        <div style={{ fontSize: "9px", letterSpacing: "0.04em", color: "var(--text-dim)", marginBottom: "14px" }}>
          Requested at 20px and under. Shown enlarged so the coarser dot art is inspectable.
        </div>
        <div class="as-grid">
          {SIXTEEN_ASSETS.map((asset) => (
            <MaskTile key={asset.path} asset={asset} size={32} />
          ))}
        </div>
      </div>
    </div>
  ),
};

export default story;
