import "../styles/gsv-fonts.css";
import "../styles/gsv-tokens.css";
import "../styles.css";
import "./features/desktop/commandPalette.css";
import "./features/presence/presence.css";
import "../design-system/catalog.css";
import { render } from "preact";
import { App } from "./App";

const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("Missing #app mount");
}

render(<App />, app);
