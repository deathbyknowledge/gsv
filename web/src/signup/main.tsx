import "../styles/gsv-fonts.css";
import "../styles/gsv-tokens.css";
import "../styles/gsv-type.css";
import "../styles.css";
import "../styles/gsv-scrollbar.css";
import { render } from "preact";
import { AuthLayout, AuthScene } from "../app/features/session/AuthLayout";
import { applyLanguagePreference, t } from "../app/i18n/locale";
import { BrowserWelcomeStorage } from "./storage";
import { loadSignupPage } from "./page";
import { signupHomepage } from "./navigation";

const accountsOrigin = window.location.origin;
const homeHref = signupHomepage(accountsOrigin);
const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing #app mount");
// The page writes its text as it loads, so its language is in place first.
void applyLanguagePreference().then(() => loadSignupPage(new BrowserWelcomeStorage(accountsOrigin), accountsOrigin))
  .then((page) => render(<AuthScene layout="welcome" homeHref={homeHref}>{page}</AuthScene>, app))
  .catch(() => render(<AuthScene layout="welcome" homeHref={homeHref}><AuthLayout visible>
    <p role="alert">{t("signup.loadFailed")}</p>
  </AuthLayout></AuthScene>, app));
