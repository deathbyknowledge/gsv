import { useMemo } from "preact/hooks";
import { AsciiAnimation } from "../../../components/ui/AsciiAnimation";
import { createSpiralScene } from "./spiralScene";
import type { ColorTheme } from "../../../components/ui/useColorTheme";
import { GlyphStars } from "./GlyphStars";
import { useT } from "../../../i18n/locale";
import "./AuthBackground.css";

export type AuthBgVariant = "galaxy" | "stars";

/**
 * Auth background. `stars` = flickering glyph star field only (onboarding).
 * `galaxy` = the GSV-forming galaxy anchored LEFT (uncovered by the form) over the
 * star field (login / register).
 */
export function AuthBackground({ variant, palette }: { variant: AuthBgVariant; palette?: ColorTheme }) {
  const t = useT();
  const spiral = useMemo(createSpiralScene, []);
  return (
    <div class="auth-bg" data-ascii-palette={palette} aria-hidden="true">
      <GlyphStars />
      {variant === "galaxy" ? (
        <div class="auth-bg-galaxy">
          <AsciiAnimation
            scene={spiral}
            className="auth-bg-galaxy-scan"
            label={t("session.scene.galaxy")}
            palette={palette}
            showTexture
          />
        </div>
      ) : null}
    </div>
  );
}
