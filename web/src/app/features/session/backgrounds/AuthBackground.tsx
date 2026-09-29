import { AsciiGalaxyScan } from "../../../components/ui/AsciiGalaxyScan";
import type { ColorTheme } from "../../../components/ui/useColorTheme";
import { GlyphStars } from "./GlyphStars";
import "./AuthBackground.css";

export type AuthBgVariant = "galaxy" | "stars";

/**
 * Auth background. `stars` = flickering glyph star field only (onboarding).
 * `galaxy` = the GSV-forming galaxy anchored LEFT (uncovered by the form) over the
 * star field (login / register).
 */
export function AuthBackground({ variant, palette }: { variant: AuthBgVariant; palette?: ColorTheme }) {
  return (
    <div class="auth-bg" data-ascii-palette={palette} aria-hidden="true">
      <GlyphStars />
      {variant === "galaxy" ? (
        <div class="auth-bg-galaxy">
          <AsciiGalaxyScan
            className="auth-bg-galaxy-scan"
            label="GSV login galaxy scan"
            palette={palette}
            showNebula={false}
            showStars={false}
            showTexture
          />
        </div>
      ) : null}
    </div>
  );
}
