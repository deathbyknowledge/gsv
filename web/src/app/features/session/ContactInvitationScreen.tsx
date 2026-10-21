import { useState } from "preact/hooks";
import { contactInvitationDestination } from "@humansandmachines/gsv/protocol";
import { AuthLayout } from "./AuthLayout";
import { SpaceAddressForm } from "./SpaceAddressForm";
import { pendingContactInvitation, contactInvitationPreview } from "../../services/session/contactInvitationIntent";
import { rich, useT } from "../../i18n/locale";
import "./LoginScreen.css";
import "./OwnerWelcomeScreen.css";

export function ContactInvitationScreen() {
  const t = useT();
  const [code] = useState(pendingContactInvitation);
  const preview = code ? contactInvitationPreview(code) : { error: t("session.contact.missing") };
  return <AuthLayout visible surfaceClass="gsv-auth-surface-login"><section class="desktop-welcome">
    <h1>{"name" in preview ? rich(t("session.contact.invitedYou"), { name: <strong class="desktop-welcome-inviter">{preview.name}</strong> }) : t("session.contact.title")}</h1>
    {"error" in preview ? <p role="alert">{preview.error}</p> : preview.expired ? <p>{t("session.contact.expired", { name: preview.name })}</p> : <>
      <p class="desktop-welcome-detail">{t("session.contact.pitch")}</p>
      <SpaceAddressForm onConnect={async (origin) => { window.location.assign(contactInvitationDestination(origin, code!)); }} />
      <p class="desktop-welcome-detail">{t("session.contact.review")}</p>
    </>}
  </section></AuthLayout>;
}
