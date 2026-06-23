import type { ComponentChildren } from "preact";
import { AuthBackground, type AuthBgVariant } from "./backgrounds/AuthBackground";
import "../../../styles/gsv-fonts.css";
import "./session-theme.css";
import "./AuthLayout.css";

export interface AuthLayoutProps {
  /** Background treatment: "galaxy" = GSV-forming galaxy + glyph stars
   *  (login / register), "stars" = flickering stars only (onboarding),
   *  "none" = plain void. */
  background?: AuthBgVariant | "none";
  /** When false the surface is hidden AND the animated background is unmounted
   *  (so its rAF loop stops while another session view is showing). */
  visible?: boolean;
  children?: ComponentChildren;
}

/** Shared auth surface: full-bleed void backdrop with the design tokens scoped
 *  (.gsv-auth-theme), the chosen background behind, and a right-aligned content
 *  slot for the panel. Used by Login and the Setup/Register wizard. */
export function AuthLayout({ background = "galaxy", visible = true, children }: AuthLayoutProps) {
  return (
    <div class="gsv-auth-theme gsv-auth-surface" hidden={!visible}>
      {visible && background !== "none" ? <AuthBackground variant={background} /> : null}
      <div class="gsv-auth-content">{children}</div>
    </div>
  );
}
