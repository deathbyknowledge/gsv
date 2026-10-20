import { LATEST_RELEASE_PAGE_URL } from "../app/domain/cliInstall";
import { rich, useT } from "../app/i18n/locale";
import "./DesktopAppLink.css";

/** Browser signup only: Desktop renders the same welcome screen and must not link to itself. */
export function DesktopAppLink() {
  const t = useT();
  return <p class="signup-desktop-app">
    {rich(t("signup.desktopApp"), { link: <a class="gsv-auth-link" href={LATEST_RELEASE_PAGE_URL} target="_blank" rel="noreferrer">{t("signup.desktopAppLink")}</a> })}
  </p>;
}
