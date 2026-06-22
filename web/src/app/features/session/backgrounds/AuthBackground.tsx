import { GalaxyGsv } from "./GalaxyGsv";
import { GlyphStars } from "./GlyphStars";
import "./AuthBackground.css";

export type AuthBgVariant = "galaxy" | "stars";

/**
 * Auth background. `stars` = flickering glyph star field only (onboarding).
 * `galaxy` = the GSV-forming galaxy anchored LEFT (uncovered by the form) over the
 * star field (login / register).
 */
export function AuthBackground({ variant }: { variant: AuthBgVariant }) {
  return (
    <div class="auth-bg" aria-hidden="true">
      <GlyphStars />
      {variant === "galaxy" ? (
        <div class="auth-bg-galaxy">
          <GalaxyGsv />
        </div>
      ) : null}
    </div>
  );
}
