import { Fragment, type VNode } from "preact";
import { AuthScene } from "../app/features/session/AuthLayout";
import { OwnerWelcomeScreen } from "../app/features/session/OwnerWelcomeScreen";
import { SpaceAddressForm } from "../app/features/session/SpaceAddressForm";
import { OwnerWelcome, SIGNUP_LINK_SLUGS, signupAttributionFromLink, type WelcomeSnapshot, type WelcomeStorage } from "../app/services/session/ownerWelcome";
import { SignupDialog } from "./SignupDialog";
import { presumedSpaceDomain, signupDestination, signupHomepage, signupMessenger } from "./navigation";
import { publicDeployment } from "../app/services/deployment";
import { captureInvite } from "./invitation";
import { contactInviteFrom } from "@humansandmachines/gsv/protocol";
import { t } from "../app/i18n/locale";

export async function loadSignupPage(storage: WelcomeStorage & { load(): Promise<WelcomeSnapshot> }, accountsOrigin: string): Promise<VNode> {
  const welcome = new URLSearchParams(window.location.search).get("view") === "welcome";
  const spaceDomain = publicDeployment().primaryDomain ?? presumedSpaceDomain(new URL(accountsOrigin).hostname);
  // Someone's invitation link names them; it carries no secret, so it only leads to a message request.
  const linked = new URL(window.location.href).searchParams.get("invite");
  let linkedInvite = contactInviteFrom(linked, spaceDomain) ? linked : null;
  let client: OwnerWelcome | undefined;
  let load: () => Promise<OwnerWelcome>;
  try {
    const snapshot = await storage.load();
    const candidate = new OwnerWelcome(snapshot, storage, accountsOrigin);
    linkedInvite = await captureInvite(candidate, linkedInvite);
    const resume = new URLSearchParams(window.location.search).get("resume") === "1";
    // The signup link names where it was clicked and which campaign brought it; that rides along until the Ship is reserved.
    const attribution = signupAttributionFromLink(new URL(window.location.href));
    if (!resume || linkedInvite) await candidate.save({ flow: welcome && !linkedInvite ? "open" : "create" });
    // A link's own origin replaces the stored one. A load without one keeps it, because the page has
    // already taken it off the URL: a reload, or a tab the phone restores, must not report the signup as direct.
    if (attribution) await candidate.save({ attribution });
    client = candidate;
    load = async () => candidate;
  } catch (error) {
    // Signup needs durable state; opening an existing space from an invitation link does not.
    load = async () => { throw error; };
  }
  const invite = contactInviteFrom(linkedInvite, spaceDomain);
  // What the link carried is kept above, so it comes off the address. Old signup links' `#invite` codes no longer authorize creation.
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const carried = SIGNUP_LINK_SLUGS.filter((slug) => (slug.part === "fragment" ? fragment : url.searchParams).has(slug.name));
  if (fragment.has("invite") || url.searchParams.has("invite") || carried.length) {
    fragment.delete("invite");
    url.searchParams.delete("invite");
    for (const slug of carried) (slug.part === "fragment" ? fragment : url.searchParams).delete(slug.name);
    url.hash = fragment.toString();
    window.history.replaceState(null, "", url);
  }
  const connect = async (origin: string, onboardingToken?: string | null) => {
    // Someone a messenger sent here finds its connection open on their new Ship.
    const messenger = signupMessenger(client?.state.attribution?.utmSource);
    const destination = signupDestination(origin, onboardingToken, { invite: invite?.profile, messenger });
    try {
      if (linkedInvite && client) await client.save({ invite: null });
    } finally {
      window.location.assign(destination);
    }
  };
  // An invitation opens as a centered card; ordinary signup lives on the page so the rest of it stays usable.
  const Frame = invite ? SignupDialog : Fragment;
  return <AuthScene layout="welcome" homeHref={signupHomepage(accountsOrigin)} headerActions={!invite && !welcome
    ? <a class="gsv-auth-link" href="/owner/signup/?view=welcome">{t("session.welcome.alreadyHaveShip")}</a> : undefined}><Frame>
    <OwnerWelcomeScreen ready resume={!welcome} initialStep={invite ? "email" : welcome ? "welcome" : "claim"} compact={!!invite}
      homeHref={invite ? undefined : signupHomepage(accountsOrigin)} spaceDomain={spaceDomain}
      invitation={invite ? { name: invite.name } : undefined} chooseSpace={!!invite}
      addressPanel={invite || welcome ? ({ connect, disabled }) => <SpaceAddressForm disabled={disabled} onConnect={connect} /> : undefined}
      load={load} onConnect={connect} /></Frame></AuthScene>;
}
