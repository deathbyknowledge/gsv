import { useState } from "preact/hooks";
import { contactInvitationDestination } from "@humansandmachines/gsv/protocol";
import { AuthLayout } from "./AuthLayout";
import { pendingContactInvitation, contactInvitationPreview } from "../../services/session/contactInvitationIntent";
import "./LoginScreen.css";
import "./OwnerWelcomeScreen.css";

export function ContactInvitationScreen() {
  const [code] = useState(pendingContactInvitation);
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const preview = code ? contactInvitationPreview(code) : { error: "This link is missing its invitation." };
  return <AuthLayout visible surfaceClass="gsv-auth-surface-login"><section class="desktop-welcome">
    <h1>{"name" in preview ? `${preview.name} invited you` : "Connect on GSV"}</h1>
    {"error" in preview ? <p role="alert">{preview.error}</p> : preview.expired ? <p>This invitation has expired. Ask {preview.name} for a new link.</p> : <>
      <p class="desktop-welcome-detail">Talk directly, share things, and let your Ships help you make plans.</p>
      <form class="gsv-login-fields" onSubmit={(event) => {
        event.preventDefault();
        try {
          const origin = new URL(/^https?:\/\//i.test(address.trim()) ? address.trim() : `https://${address.trim()}`);
          if (origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) throw new Error("Enter your GSV space address.");
          window.location.assign(contactInvitationDestination(origin.origin, code!));
        } catch (failure) { setError(failure instanceof Error ? failure.message : "Enter your GSV space address."); }
      }}>
        <label>Your GSV space<input class="gsv-input" value={address} placeholder="your-name.gsv.space" autoFocus autoComplete="url" spellcheck={false} onInput={(event) => setAddress(event.currentTarget.value)} /></label>
        <button class="gsv-btn gsv-btn-primary gsv-btn-block" disabled={!address.trim()} type="submit">open my space</button>
      </form>
      <p class="desktop-welcome-detail">You’ll review the invitation in your own space before connecting.</p>
    </>}
    {error && <p role="alert">{error}</p>}
  </section></AuthLayout>;
}
