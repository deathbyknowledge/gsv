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
import { captureContactInvitation } from "./invitation";
import { contactInvitationDestination } from "@humansandmachines/gsv/protocol";
import { pendingContactInvitation, contactInvitationPreview, clearContactInvitation } from "../app/services/session/contactInvitationIntent";

const accountsOrigin = window.location.origin;
const storage = new BrowserWelcomeStorage(accountsOrigin);
const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing #app mount");

async function startSignup() {
  const client = new OwnerWelcome(await storage.load(), storage, accountsOrigin);
  const contactInvitation = await captureContactInvitation(client, pendingContactInvitation());
  const preview = contactInvitation ? contactInvitationPreview(contactInvitation) : null;
  const invitationError = preview && ("error" in preview ? preview.error
    : preview.expired ? `Your invitation from ${preview.name} has expired. Ask them for a new link.` : null);
  const resume = new URLSearchParams(window.location.search).get("resume") === "1";
  if (!resume || contactInvitation) await client.save({ flow: "create" });
  // Old signup links remain useful destinations, but their codes no longer authorize creation.
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (fragment.has("invite")) { fragment.delete("invite"); url.hash = fragment.toString(); window.history.replaceState(null, "", url); }
  const connect = async (origin: string, onboardingToken?: string | null) => {
    const destination = onboardingToken ? signupDestination(origin, onboardingToken, contactInvitation)
      : contactInvitation ? contactInvitationDestination(origin, contactInvitation) : signupDestination(origin);
    if (contactInvitation) await client.save({ contactInvite: null });
    clearContactInvitation();
    window.location.assign(destination);
  };
  render(<AuthScene layout="welcome"><SignupDialog>{invitationError
    ? <AuthLayout visible><section class="desktop-welcome"><h1>Connect on Ship</h1><p role="alert">{invitationError}</p>
      <a class="gsv-auth-link" href="/owner/signup/?resume=1" onClick={async (event) => {
        event.preventDefault(); await client.save({ contactInvite: null }); clearContactInvitation(); window.location.assign("/owner/signup/?resume=1");
      }}>open my spaces</a></section></AuthLayout>
    : <OwnerWelcomeScreen ready resume initialStep="email" compact
      invitation={preview && "name" in preview ? preview : undefined} chooseSpace={!!contactInvitation}
      addressPanel={contactInvitation ? ({ connect, disabled }) => <SpaceAddressForm disabled={disabled} onConnect={connect} /> : undefined}
      load={async () => client} onConnect={connect} />}{!contactInvitation && <DesktopAppLink />}</SignupDialog></AuthScene>, app!);
}

void startSignup().catch(() => render(<AuthScene layout="welcome"><SignupDialog><AuthLayout visible>
  <p role="alert">Could not load sign-in. Reload to try again.</p>
</AuthLayout></SignupDialog></AuthScene>, app));
