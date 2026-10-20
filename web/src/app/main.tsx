import "../styles/gsv-fonts.css";
import "../styles/gsv-tokens.css";
// Foundational type utilities — imported at the entry so they load BEFORE any
// component CSS. Components rely on this order: their own class overrides
// (tracking/color/weight) must win over these equal-specificity utilities.
import "../styles/gsv-type.css";
import "../styles.css";
import "../styles/gsv-scrollbar.css";
import { render } from "preact";
import { App } from "./App";
import { applyLanguagePreference } from "./i18n/locale";

const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("Missing #app mount");
}

applyLanguagePreference();
render(<App />, app);
