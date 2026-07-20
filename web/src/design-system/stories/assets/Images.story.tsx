import type { Story } from "../../story";
import { ImgTile, MaskTile, type AssetEntry } from "./tiles";
import "../../assets.css";

/**
 * Image assets — inventory of web/public raster and SVG art. Files are
 * referenced directly by URL path (no imports from doticons.ts / Icon.tsx).
 *
 * `used` flags are from a manual grep audit (2026-07-13) of web/src,
 * index.html, manifest.webmanifest, and gsv-service-worker.js. References
 * only from the design-system catalog itself count as UNUSED.
 */

// web/public/img/ — agent portraits + human orb.
// All five portraits are reachable via agentPresentation's AGENT_IMAGE_POOL
// (fixed per-agent assignment) and AgentImage's `/img/agent-${idx}.png`
// template; orb via CREW_HUMAN_IMAGE.
const IMG_ASSETS: AssetEntry[] = [
  { path: "/img/agent-0.png", name: "agent-0.png", used: true },
  { path: "/img/agent-1.png", name: "agent-1.png", used: true },
  { path: "/img/agent-2.png", name: "agent-2.png", used: true },
  { path: "/img/agent-3.png", name: "agent-3.png", used: true },
  { path: "/img/agent-4.png", name: "agent-4.png", used: true },
  { path: "/img/orb.png", name: "orb.png", used: true },
];

// web/public/brand/ + the root favicon — all reached via GsvMark / index.html.
const BRAND_ASSETS: AssetEntry[] = [
  { path: "/brand/gsv-mark-master.svg", name: "gsv-mark-master.svg", used: true },
  { path: "/brand/gsv-mark-white.svg", name: "gsv-mark-white.svg", used: true },
  { path: "/favicon.svg", name: "favicon.svg", used: true },
];

// web/public/icons/*.svg — single-colour mask art, painted via Icon (gsv
// family). All 16 are referenced by name somewhere in the app; notably
// satellite via OBJECT_GLYPH_ICON.applications and rss via
// ApplicationImportFlow's flow icon.
const APP_ICON_ASSETS: AssetEntry[] = [
  { path: "/icons/bookmark.svg", name: "bookmark", used: true },
  { path: "/icons/chat.svg", name: "chat", used: true },
  { path: "/icons/cog.svg", name: "cog", used: true },
  { path: "/icons/computer.svg", name: "computer", used: true },
  { path: "/icons/discord.svg", name: "discord", used: true },
  { path: "/icons/folder.svg", name: "folder", used: true },
  { path: "/icons/gmail.svg", name: "gmail", used: true },
  { path: "/icons/list.svg", name: "list", used: true },
  { path: "/icons/pencil.svg", name: "pencil", used: true },
  { path: "/icons/plus.svg", name: "plus", used: true },
  { path: "/icons/rss.svg", name: "rss", used: true },
  { path: "/icons/satellite.svg", name: "satellite", used: true },
  { path: "/icons/stars.svg", name: "stars", used: true },
  { path: "/icons/telegram.svg", name: "telegram", used: true },
  { path: "/icons/terminal.svg", name: "terminal", used: true },
  { path: "/icons/weblink.svg", name: "weblink", used: true },
];

// PWA installability icons — apple-touch via index.html, the rest via
// manifest.webmanifest.
const PWA_ASSETS: AssetEntry[] = [
  { path: "/icons/apple-touch-icon.png", name: "apple-touch-icon.png", used: true },
  { path: "/icons/gsv-192.png", name: "gsv-192.png", used: true },
  { path: "/icons/gsv-512.png", name: "gsv-512.png", used: true },
  { path: "/icons/gsv-maskable-192.png", name: "gsv-maskable-192.png", used: true },
  { path: "/icons/gsv-maskable-512.png", name: "gsv-maskable-512.png", used: true },
];

const story: Story = {
  title: "Images",
  group: "Assets",
  blurb: "web/public inventory · img, brand, app icons, PWA · UNUSED badges from grep audit",
  render: () => (
    <div class="ds-col">
      <div class="as-section">
        <div class="ds-label" style={{ marginBottom: "14px" }}>
          /img · agent portraits + human orb (crew, chat, agent editor)
        </div>
        <div class="as-grid">
          {IMG_ASSETS.map((asset) => (
            <ImgTile key={asset.path} asset={asset} imgSize={56} />
          ))}
        </div>
      </div>

      <div class="as-section">
        <div class="ds-label" style={{ marginBottom: "14px" }}>
          /brand + favicon · ship mark (multi-tone pixel art, rendered as image)
        </div>
        <div class="as-grid">
          {BRAND_ASSETS.map((asset) => (
            <ImgTile key={asset.path} asset={asset} imgSize={44} />
          ))}
        </div>
      </div>

      <div class="as-section">
        <div class="ds-label" style={{ marginBottom: "4px" }}>
          /icons · curated app masks · shown tinted, as the app paints them
        </div>
        <div style={{ fontSize: "9px", letterSpacing: "0.04em", color: "var(--text-dim)", marginBottom: "14px" }}>
          Single-colour SVGs applied via CSS mask-image; a raw img would be invisible on the void.
        </div>
        <div class="as-grid">
          {APP_ICON_ASSETS.map((asset) => (
            <MaskTile key={asset.path} asset={asset} size={34} />
          ))}
        </div>
      </div>

      <div class="as-section">
        <div class="ds-label" style={{ marginBottom: "14px" }}>
          PWA icons · index.html + manifest.webmanifest
        </div>
        <div class="as-pwa-row">
          {PWA_ASSETS.map((asset) => (
            <ImgTile key={asset.path} asset={asset} imgSize={40} />
          ))}
        </div>
      </div>
    </div>
  ),
};

export default story;
