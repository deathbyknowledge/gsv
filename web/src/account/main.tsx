import { render } from "preact";
import { AccountApp } from "./AccountApp";
import { claimFromHash } from "./telegram/domain";
import { verificationTokenFromHash } from "./home/domain";
import "../styles/gsv-fonts.css";
import "../styles/gsv-tokens.css";
import "./styles.css";
import "./home/styles.css";

const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("Missing #app mount");
}

const claimToken = claimFromHash(window.location.hash);
const verificationToken = verificationTokenFromHash(window.location.hash);
const checkout = new URLSearchParams(window.location.search).get("checkout");
const checkoutReturn = checkout === "complete" || checkout === "cancelled"
  ? checkout
  : null;
const cleanSearch = new URLSearchParams(window.location.search);
cleanSearch.delete("checkout");
const cleanLocation = `${window.location.pathname}${cleanSearch.size > 0 ? `?${cleanSearch}` : ""}`;
window.history.replaceState(window.history.state, "", cleanLocation);
document.title = window.location.pathname.startsWith("/billing")
  ? "Billing · GSV"
  : window.location.pathname.startsWith("/telegram")
    ? "Connect Telegram · GSV"
    : "Your GSV";

render(
  <AccountApp
    pathname={window.location.pathname}
    claimToken={claimToken}
    verificationToken={verificationToken}
    checkoutReturn={checkoutReturn}
  />,
  app,
);
