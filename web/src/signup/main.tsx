import "../styles/gsv-fonts.css";
import "../styles/gsv-tokens.css";
import "../styles/gsv-type.css";
import "../styles.css";
import "../styles/gsv-scrollbar.css";
import { render } from "preact";
import { AuthScene } from "../app/features/session/AuthLayout";
import { OwnerWelcomeScreen } from "../app/features/session/OwnerWelcomeScreen";
import { OwnerWelcome } from "../app/services/session/ownerWelcome";
import { BrowserWelcomeStorage } from "./storage";
import { DesktopAppLink } from "./DesktopAppLink";
import { signupDestination } from "./navigation";

const accountsOrigin = window.location.origin;
const storage = new BrowserWelcomeStorage(accountsOrigin);
async function load() { return new OwnerWelcome(await storage.load(), storage, accountsOrigin); }
async function connect(origin: string, onboardingToken?: string | null, username?: string) {
  window.location.assign(signupDestination(origin, onboardingToken, username));
}

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing #app mount");
const resume = new URLSearchParams(window.location.search).get("resume") === "1";
render(<AuthScene layout="welcome"><OwnerWelcomeScreen ready resume={resume} initialStep={resume ? "email" : "invite"}
  load={load} onConnect={connect} /><DesktopAppLink /></AuthScene>, app);
