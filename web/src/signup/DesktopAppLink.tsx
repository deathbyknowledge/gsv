import { LATEST_RELEASE_PAGE_URL } from "../app/domain/cliInstall";
import "./DesktopAppLink.css";

/** Browser signup only: Desktop renders the same welcome screen and must not link to itself. */
export function DesktopAppLink() {
  return <p class="signup-desktop-app">
    Prefer an app? <a class="gsv-auth-link" href={LATEST_RELEASE_PAGE_URL} target="_blank" rel="noreferrer">Try the beta desktop app</a> for
    macOS and Linux. Your invite code works there too.
  </p>;
}
