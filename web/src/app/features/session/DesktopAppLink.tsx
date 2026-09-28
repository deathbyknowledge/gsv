import { LATEST_RELEASE_PAGE_URL } from "../../domain/cliInstall";
import "./DesktopAppLink.css";

/**
 * Browser-only pointer at the beta Desktop download. Desktop renders the same welcome and setup
 * screens, so hosts supply this through an entry-level slot rather than the screens themselves.
 */
export function DesktopAppLink({ variant }: { variant: "signup" | "setup" }) {
  const link = (label: string) => <a class="gsv-auth-link" href={LATEST_RELEASE_PAGE_URL} target="_blank" rel="noreferrer">{label}</a>;
  if (variant === "setup") {
    return <p class="gsv-setup-desktop-app">You can also use GSV as a desktop app on macOS and Linux. {link("Try the beta")}.</p>;
  }
  return <p class="signup-desktop-app">
    Prefer an app? {link("Try the beta desktop app")} for macOS and Linux. Your invite code works there too.
  </p>;
}
