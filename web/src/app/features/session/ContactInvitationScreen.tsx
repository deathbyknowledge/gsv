import { useState } from "preact/hooks";
import { contactInvitationDestination } from "@humansandmachines/gsv/protocol";
import { AuthLayout } from "./AuthLayout";
import { SpaceAddressForm } from "./SpaceAddressForm";
import { pendingContactInvitation, contactInvitationPreview } from "../../services/session/contactInvitationIntent";
import "./LoginScreen.css";
import "./OwnerWelcomeScreen.css";

export function ContactInvitationScreen() {
  const [code] = useState(pendingContactInvitation);
  const preview = code ? contactInvitationPreview(code) : { error: "This link is missing its invitation." };
  return <AuthLayout visible surfaceClass="gsv-auth-surface-login"><section class="desktop-welcome">
    <h1>{"name" in preview ? `${preview.name} invited you` : "Connect on GSV"}</h1>
    {"error" in preview ? <p role="alert">{preview.error}</p> : preview.expired ? <p>This invitation has expired. Ask {preview.name} for a new link.</p> : <>
      <p class="desktop-welcome-detail">Talk directly, share things, and let your Ships help you make plans.</p>
      <SpaceAddressForm onConnect={async (origin) => { window.location.assign(contactInvitationDestination(origin, code!)); }} />
      <p class="desktop-welcome-detail">You’ll review the invitation in your own space before connecting.</p>
    </>}
  </section></AuthLayout>;
}
