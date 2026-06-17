import "../styles.css";
import "./features/presence/presence.css";
import { render } from "preact";
import { App } from "./App";

const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("Missing #app mount");
}

render(<App />, app);
