import { Fragment, type VNode } from "preact";
import { AuthLayout } from "../app/features/session/AuthLayout";
import { OwnerWelcomeScreen } from "../app/features/session/OwnerWelcomeScreen";
import { SpaceAddressForm } from "../app/features/session/SpaceAddressForm";
import { OwnerWelcome, type WelcomeSnapshot, type WelcomeStorage } from "../app/services/session/ownerWelcome";
import { DesktopAppLink } from "./DesktopAppLink";
import { SignupDialog } from "./SignupDialog";
import { presumedSpaceDomain, signupDestination } from "./navigation";
import { publicDeployment } from "../app/services/deployment";
import { captureContactInvitation } from "./invitation";
import { contactInvitationDestination } from "@humansandmachines/gsv/protocol";
import { pendingContactInvitation, contactInvitationPreview, clearContactInvitation } from "../app/services/session/contactInvitationIntent";
import { t } from "../app/i18n/locale";

export async function loadSignupPage(storage: WelcomeStorage & { load(): Promise<WelcomeSnapshot> }, accountsOrigin: string): Promise<VNode> {
  let contactInvitation = pendingContactInvitation();
  let client: OwnerWelcome | undefined;
  let load: () => Promise<OwnerWelcome>;
  try {
    const snapshot = await storage.load();
    contactInvitation ??= snapshot.value?.contactInvite ?? null;
    const candidate = new OwnerWelcome(snapshot, storage, accountsOrigin);
    await captureContactInvitation(candidate, contactInvitation);
    const resume = new URLSearchParams(window.location.search).get("resume") === "1";
    if (!resume || contactInvitation) await candidate.save({ flow: "create" });
    client = candidate;
    load = async () => candidate;
  } catch (error) {
    // Signup needs durable state; opening an existing space with a contact link does not.
    load = async () => { throw error; };
  }
  const preview = contactInvitation ? contactInvitationPreview(contactInvitation) : null;
  const invitationError = preview && ("error" in preview ? preview.error
    : preview.expired ? t("signup.invitationExpired", { name: preview.name }) : null);
  // Old signup links remain useful destinations, but their codes no longer authorize creation.
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (fragment.has("invite")) { fragment.delete("invite"); url.hash = fragment.toString(); window.history.replaceState(null, "", url); }
  const leave = async (destination: string) => {
    try {
      if (contactInvitation && client) await client.save({ contactInvite: null });
    } finally {
      clearContactInvitation();
      window.location.assign(destination);
    }
  };
  const connect = async (origin: string, onboardingToken?: string | null) => {
    const destination = onboardingToken ? signupDestination(origin, onboardingToken, contactInvitation)
      : contactInvitation ? contactInvitationDestination(origin, contactInvitation) : signupDestination(origin);
    await leave(destination);
  };
  // A friend's invitation opens as a centered card; ordinary signup lives on the page so the rest of it stays usable.
  const Frame = contactInvitation ? SignupDialog : Fragment;
  return <Frame>{invitationError
    ? <AuthLayout visible><section class="desktop-welcome"><h1>{t("session.contact.title")}</h1><p role="alert">{invitationError}</p>
      <a class="gsv-auth-link" href="/owner/signup/?resume=1" onClick={async (event) => {
        event.preventDefault(); await leave("/owner/signup/?resume=1");
      }}>{t("signup.openShip")}</a></section></AuthLayout>
    : <OwnerWelcomeScreen ready resume initialStep={contactInvitation ? "email" : "claim"} compact={!!contactInvitation}
      spaceDomain={publicDeployment().primaryDomain ?? presumedSpaceDomain(new URL(accountsOrigin).hostname)}
      invitation={preview && "name" in preview ? preview : undefined} chooseSpace={!!contactInvitation}
      addressPanel={contactInvitation ? ({ connect, disabled }) => <SpaceAddressForm disabled={disabled} onConnect={connect} /> : undefined}
      load={load} onConnect={connect} />}{!contactInvitation && <DesktopAppLink />}</Frame>;
}
