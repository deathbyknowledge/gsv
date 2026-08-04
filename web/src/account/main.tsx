import { render } from "preact";
import { AccountApp } from "./AccountApp";
import { claimFromHash, locationWithoutHash } from "./telegram/domain";
import "../styles/gsv-fonts.css";
import "../styles/gsv-tokens.css";
import "./styles.css";

const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("Missing #app mount");
}

const claimToken = claimFromHash(window.location.hash);
window.history.replaceState(
  window.history.state,
  "",
  locationWithoutHash(window.location),
);

render(<AccountApp claimToken={claimToken} />, app);
