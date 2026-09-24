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
import { signupDestination } from "./navigation";

const accountsOrigin = window.location.origin;
const storage = new BrowserWelcomeStorage(accountsOrigin);
async function load() { return new OwnerWelcome(await storage.load(), storage, accountsOrigin); }
async function connect(origin: string, onboardingToken?: string | null) {
  window.location.assign(signupDestination(origin, onboardingToken));
}

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing #app mount");
render(<AuthScene><OwnerWelcomeScreen ready resume={false} initialStep="invite"
  accountsOrigin={accountsOrigin} load={load} onConnect={connect} /></AuthScene>, app);
