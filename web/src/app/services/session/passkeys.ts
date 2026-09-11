import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { GSVClient } from "@humansandmachines/gsv/client";
import type { SessionService } from "./sessionService";

export type PasskeyAuthenticator = { register: typeof startRegistration; authenticate: typeof startAuthentication };
const authenticator: PasskeyAuthenticator = { register: startRegistration, authenticate: startAuthentication };

export function supportsPasskeys(): boolean { return browserSupportsWebAuthn(); }

export async function enrollPasskey(client: { account: { passkey: { register: Pick<GSVClient["account"]["passkey"]["register"], "begin" | "finish"> } } }, label: string, browser: PasskeyAuthenticator = authenticator) {
  const start = await client.account.passkey.register.begin({ label });
  const response = await browser.register({ optionsJSON: start.options });
  return client.account.passkey.register.finish({ id: start.id, response });
}

/** WebAuthn's short-lived token enters the ordinary session path and rotates there. */
export async function signInWithPasskey(session: Pick<SessionService, "snapshot" | "login"> & { client: Pick<SessionService["client"], "requestOnce"> }, username: string, browser: PasskeyAuthenticator = authenticator): Promise<void> {
  const url = session.snapshot().url;
  const start = await session.client.requestOnce(url, "account.passkey.authenticate.begin", { username });
  const response = await browser.authenticate({ optionsJSON: start.options });
  const authenticated = await session.client.requestOnce(url, "account.passkey.authenticate.finish", { id: start.id, response });
  await session.login({ username: authenticated.username, token: authenticated.token });
}
