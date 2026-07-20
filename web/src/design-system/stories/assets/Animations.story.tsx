import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { Story } from "../../story";
import { AsciiPlanet } from "../../../app/components/ui/AsciiPlanet";
import { AsciiGalaxyScan } from "../../../app/components/ui/AsciiGalaxyScan";
import { AuthBackground } from "../../../app/features/session/backgrounds/AuthBackground";
import { createAppLaunchLoader } from "../../../app/features/desktop/runtime/appLoading";
import { TemplateEmptyState } from "../../../app/features/gsv-console/list-template/TemplateEmptyState";
import "../../assets.css";

/**
 * Animation assets — the live ascii/animated pieces, rendered in contained
 * cells. Usage audit (manual grep, 2026-07-13): every piece here has live app
 * usage, so no UNUSED badges apply.
 *  - AsciiPlanet          → TemplateEmptyState, ConsoleOverviewPanels
 *  - AsciiGalaxyScan      → AuthBackground, app-launch loader
 *  - AuthBackground       → AuthLayout (stars variant = GlyphStars alone)
 *  - createAppLaunchLoader→ appsRuntime (desktop app boot overlay)
 *  - TemplateEmptyState   → ListTemplate, CardListTemplate
 */

/** Live mount of the imperative app-launch loader (appLoading.ts exports a
 *  DOM factory, not a component). Its overlay chrome lives in the app-global
 *  styles.css, so the catalog carries a scoped copy under .as-applaunch. */
function AppLaunchLoaderCell() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const loader = createAppLaunchLoader({
      appName: "Weather",
      route: "/apps/weather",
      seed: "ds-assets",
    });
    loader.setPhase("runtime", "Loading app");
    host.append(loader.element);
    return () => {
      loader.destroy();
      loader.element.remove();
    };
  }, []);

  return <div ref={hostRef} class="as-anim-cell as-applaunch" style={{ height: "320px" }} />;
}

const AUTH_GALAXY_CELL_STYLE = {
  position: "relative",
  height: "320px",
  // AuthBackground reserves space for the login panel; shrink the reserve so
  // the galaxy zone fits the catalog cell.
  "--gsv-galaxy-reserve": "120px",
} as JSX.CSSProperties;

const story: Story = {
  title: "Animations",
  group: "Assets",
  blurb: "live ascii pieces · planets, galaxy scan, auth + app-launch backdrops",
  render: () => (
    <div class="ds-col">
      <div class="as-section">
        <div class="ds-label" style={{ marginBottom: "14px" }}>
          AsciiPlanet · all variants (moon live; others static for compactness)
        </div>
        <div class="ds-row" style={{ alignItems: "flex-start" }}>
          <div class="ds-cell">
            <div class="ds-label">moon (animated)</div>
            <AsciiPlanet variant="moon" formDuration={3.4} />
          </div>
          <div class="ds-cell">
            <div class="ds-label">orbit</div>
            <AsciiPlanet variant="orbit" animate={false} />
          </div>
        </div>
        <div class="ds-row" style={{ alignItems: "center", marginTop: "18px" }}>
          <div class="ds-cell">
            <div class="ds-label">giant</div>
            <AsciiPlanet variant="giant" animate={false} />
          </div>
          <div class="ds-cell">
            <div class="ds-label">disc · terminator · crescent · orb</div>
            <div class="ds-row" style={{ alignItems: "center" }}>
              <AsciiPlanet variant="disc" animate={false} />
              <AsciiPlanet variant="terminator" animate={false} />
              <AsciiPlanet variant="crescent" animate={false} />
              <AsciiPlanet variant="orb" size={60} animate={false} />
            </div>
          </div>
        </div>
      </div>

      <div class="as-section">
        <div class="ds-label" style={{ marginBottom: "14px" }}>
          AsciiGalaxyScan · procedural galaxy forming the GSV mark
        </div>
        <AsciiGalaxyScan showReplay />
      </div>

      <div class="as-section">
        <div class="ds-label" style={{ marginBottom: "14px" }}>
          AuthBackground · galaxy variant (login / register) · viewport-coupled, clipped to a fixed cell
        </div>
        <div class="as-anim-cell" style={AUTH_GALAXY_CELL_STYLE}>
          <AuthBackground variant="galaxy" />
        </div>
        <div class="ds-label" style={{ margin: "18px 0 14px" }}>
          AuthBackground · stars variant (onboarding) — the GlyphStars field alone
        </div>
        <div class="as-anim-cell" style={{ position: "relative", height: "220px" }}>
          <AuthBackground variant="stars" />
        </div>
      </div>

      <div class="as-section">
        <div class="ds-label" style={{ marginBottom: "14px" }}>
          App-launch loader (appLoading.ts) · live galaxy scan forming "APP", held in the runtime phase
        </div>
        <AppLaunchLoaderCell />
      </div>

      <div class="as-section">
        <div class="ds-label" style={{ marginBottom: "14px" }}>
          TemplateEmptyState · AsciiPlanet banner + amber "NO OBJECT" readout
        </div>
        <div class="as-anim-cell">
          <TemplateEmptyState object="ASSETS" />
        </div>
      </div>

      <div class="as-section">
        <div style={{ fontSize: "9px", letterSpacing: "0.06em", color: "var(--text-dim)" }}>
          NOTE: audio assets exist in public/notification-sounds (one .wav) but are out of scope for this tab.
        </div>
      </div>
    </div>
  ),
};

export default story;
