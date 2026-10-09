import "../styles/gsv-fonts.css";
import "../styles/gsv-tokens.css";
import "../styles/gsv-type.css";
import "../styles.css";
import "../styles/gsv-scrollbar.css";
import { render } from "preact";
import { AuthLayout, AuthScene } from "../app/features/session/AuthLayout";
import { OwnerWelcomeScreen } from "../app/features/session/OwnerWelcomeScreen";
import { SpaceAddressForm } from "../app/features/session/SpaceAddressForm";
import { OwnerWelcome } from "../app/services/session/ownerWelcome";
import { BrowserWelcomeStorage } from "./storage";
import { DesktopAppLink } from "./DesktopAppLink";
import { signupDestination } from "./navigation";
import { contactInvitationDestination } from "@humansandmachines/gsv/protocol";
import { pendingContactInvitation, contactInvitationPreview, clearContactInvitation } from "../app/services/session/contactInvitationIntent";

const accountsOrigin = window.location.origin;
const storage = new BrowserWelcomeStorage(accountsOrigin);
const contactInvitation = pendingContactInvitation();
const invitationPreview = contactInvitation ? contactInvitationPreview(contactInvitation) : null;
async function load() { return new OwnerWelcome(await storage.load(), storage, accountsOrigin); }
async function connect(origin: string, onboardingToken?: string | null) {
  const destination = contactInvitation ? contactInvitationDestination(origin, contactInvitation) : signupDestination(origin, onboardingToken);
  clearContactInvitation();
  window.location.assign(destination);
}

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing #app mount");
const resume = !!contactInvitation || new URLSearchParams(window.location.search).get("resume") === "1";
const invitationError = invitationPreview && ("error" in invitationPreview ? invitationPreview.error
  : invitationPreview.expired ? `Your invitation from ${invitationPreview.name} has expired. Ask them for a new link.` : null);
render(<AuthScene layout="welcome">{invitationError
  ? <AuthLayout visible><section class="desktop-welcome"><h1>Connect on GSV</h1><p role="alert">{invitationError}</p>
    <a class="gsv-auth-link" href="/owner/signup/?resume=1" onClick={clearContactInvitation}>open my spaces</a></section></AuthLayout>
  : <OwnerWelcomeScreen ready resume={resume} initialStep={resume ? "email" : "invite"}
    chooseSpace={!!contactInvitation} context={invitationPreview && "name" in invitationPreview && <p class="desktop-welcome-detail">
      {invitationPreview.name} invited you to connect. Choose your space or enter its address, then accept their invitation.</p>}
    addressPanel={contactInvitation ? ({ connect, disabled }) => <SpaceAddressForm disabled={disabled} onConnect={connect} /> : undefined}
    load={load} onConnect={connect} />}{!contactInvitation && <DesktopAppLink />}</AuthScene>, app);
