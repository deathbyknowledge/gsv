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
import { SignupDialog } from "./SignupDialog";
import { signupDestination } from "./navigation";
import { captureCreationInvitation } from "./invitation";
import { contactInvitationDestination, parseCreationInvitation } from "@humansandmachines/gsv/protocol";
import { pendingContactInvitation, contactInvitationPreview, clearContactInvitation } from "../app/services/session/contactInvitationIntent";

const accountsOrigin = window.location.origin;
const storage = new BrowserWelcomeStorage(accountsOrigin);
const supplied = new URLSearchParams(window.location.hash.slice(1));
if (supplied.has("invite") && !supplied.has("contact")) clearContactInvitation();
const contactInvitation = pendingContactInvitation();
const invitationPreview = contactInvitation ? contactInvitationPreview(contactInvitation) : null;
async function load() {
  const client = new OwnerWelcome(await storage.load(), storage, accountsOrigin);
  await captureCreationInvitation(client, window.location.href, (url) => window.history.replaceState(null, "", url), contactInvitation);
  return client;
}
async function connect(origin: string, onboardingToken?: string | null) {
  const destination = onboardingToken ? signupDestination(origin, onboardingToken, contactInvitation)
    : contactInvitation ? contactInvitationDestination(origin, contactInvitation) : signupDestination(origin);
  clearContactInvitation();
  window.location.assign(destination);
}

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing #app mount");
const resume = !!contactInvitation || new URLSearchParams(window.location.search).get("resume") === "1";
let creationError: string | null = null;
if (new URLSearchParams(window.location.hash.slice(1)).has("invite")) {
  try { parseCreationInvitation(window.location.href); }
  catch { creationError = "This invitation link is incomplete. Ask for the full link."; }
}
const invitationError = creationError || (invitationPreview && ("error" in invitationPreview ? invitationPreview.error
  : invitationPreview.expired ? `Your invitation from ${invitationPreview.name} has expired. Ask them for a new link.` : null));
const invitation = invitationPreview && "name" in invitationPreview ? invitationPreview : supplied.has("invite") ? {} : undefined;
render(<AuthScene layout="welcome"><SignupDialog>{invitationError
  ? <AuthLayout visible><section class="desktop-welcome"><h1>Connect on GSV</h1><p role="alert">{invitationError}</p>
    <a class="gsv-auth-link" href="/owner/signup/?resume=1" onClick={clearContactInvitation}>open my spaces</a></section></AuthLayout>
  : <OwnerWelcomeScreen ready resume={resume} initialStep={resume ? "email" : "invite"} compact invitation={invitation}
    chooseSpace={!!contactInvitation} signupContactCode={contactInvitation ?? undefined}
    addressPanel={contactInvitation ? ({ connect, disabled }) => <SpaceAddressForm disabled={disabled} onConnect={connect} /> : undefined}
    load={load} onConnect={connect} />}{!invitation && !contactInvitation && <DesktopAppLink />}</SignupDialog></AuthScene>, app);
