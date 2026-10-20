import "../styles/gsv-fonts.css";
import "../styles/gsv-tokens.css";
import "../styles/gsv-type.css";
import "../styles.css";
import "../styles/gsv-scrollbar.css";
import { render } from "preact";
import { DesktopApp } from "./DesktopApp";
import { applyLanguagePreference } from "../app/i18n/locale";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing #app mount");
// The first screen waits for its language, so it never shows English before a translation arrives.
void applyLanguagePreference().then(() => render(<DesktopApp />, app));
