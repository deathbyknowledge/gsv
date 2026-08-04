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
const checkout = new URLSearchParams(window.location.search).get("checkout");
const checkoutReturn = checkout === "complete" || checkout === "cancelled"
  ? checkout
  : null;
window.history.replaceState(
  window.history.state,
  "",
  locationWithoutHash(window.location),
);
document.title = window.location.pathname.startsWith("/billing")
  ? "Billing · GSV"
  : "Connect Telegram · GSV";

render(
  <AccountApp
    pathname={window.location.pathname}
    claimToken={claimToken}
    checkoutReturn={checkoutReturn}
  />,
  app,
);
