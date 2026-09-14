import { createContext, type ComponentChildren } from "preact";
import { useContext } from "preact/hooks";
import { useColorTheme } from "../../components/ui/useColorTheme";
import { AuthBackground, type AuthBgVariant } from "./backgrounds/AuthBackground";
import "../../../styles/gsv-fonts.css";
import "./session-theme.css";
import "./AuthLayout.css";

const SharedAuthScene = createContext(false);

/** Keep one animation alive while local sign-in, recovery, and setup panels change. */
export function AuthScene({ children, setup = false }: { children: ComponentChildren; setup?: boolean }) {
  const { theme } = useColorTheme();
  return (
    <div class={`gsv-auth-theme gsv-auth-surface gsv-auth-scene${theme === "light" ? " is-light" : ""}${setup ? " gsv-auth-surface-setup" : " gsv-auth-surface-login"}`}>
      <AuthBackground variant="galaxy" palette={theme} />
      <SharedAuthScene.Provider value>{children}</SharedAuthScene.Provider>
    </div>
  );
}

export interface AuthLayoutProps {
  /** Background treatment: "galaxy" = GSV-forming galaxy + glyph stars
   *  (login / register), "stars" = flickering stars only (onboarding),
   *  "none" = plain void. */
  background?: AuthBgVariant | "none";
  /** When false the surface is hidden AND the animated background is unmounted
   *  (so its rAF loop stops while another session view is showing). */
  visible?: boolean;
  /** Extra class on the surface root (e.g. to set --gsv-galaxy-reserve for a
   *  wider panel). */
  surfaceClass?: string;
  children?: ComponentChildren;
}

/** Shared auth surface: full-bleed void backdrop with the design tokens scoped
 *  (.gsv-auth-theme), the chosen background behind, and a right-aligned content
 *  slot for the panel. Used by Login and the Setup/Register wizard. */
export function AuthLayout({ background = "galaxy", visible = true, surfaceClass, children }: AuthLayoutProps) {
  const { theme } = useColorTheme();
  const sharedScene = useContext(SharedAuthScene);
  return (
    <div class={`gsv-auth-theme gsv-auth-surface${sharedScene ? " gsv-auth-surface-shared" : ""}${theme === "light" ? " is-light" : ""}${surfaceClass ? ` ${surfaceClass}` : ""}`} hidden={!visible}>
      {visible && !sharedScene && background !== "none" ? <AuthBackground variant={background} palette={theme} /> : null}
      <div class="gsv-auth-content">{children}</div>
    </div>
  );
}
