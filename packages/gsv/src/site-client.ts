import * as z from "zod/mini";
import { GSVClient } from "./client";
import { siteIdSchema, type SiteAuthorization, type SiteBootstrap } from "./protocol/syscalls/site";

const AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;
const SESSION_DURATION_MS = 60 * 60_000;
const CALLS = ["r12y.list", "r12y.get"];
const SIGNALS = ["r12y.changed"];
const originSchema = z.string().check(z.maxLength(2048), z.refine((value) => {
  try { return new URL(value).protocol === "https:" && new URL(value).origin === value; }
  catch { return false; }
}, "Expected an HTTPS origin"));
const publicationIdentity = {
  installationId: z.string().check(z.minLength(1), z.maxLength(128)),
  siteId: siteIdSchema,
  siteOrigin: originSchema,
  gatewayOrigin: originSchema,
};
const bootstrapSchema = z.strictObject({ version: z.literal(1), ...publicationIdentity });
const authorizationSchema = z.strictObject({
  ...publicationIdentity,
  token: z.string().check(z.minLength(1), z.maxLength(4096)),
  tokenId: z.string().check(z.minLength(1), z.maxLength(128)),
  expiresAtMs: z.int().check(z.positive()),
  calls: z.tuple([z.literal("r12y.list"), z.literal("r12y.get")]),
  signals: z.tuple([z.literal("r12y.changed")]),
}) satisfies z.ZodMiniType<SiteAuthorization>;
const messageSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("gsv.site.authorization"), nonce: z.string(), authorization: authorizationSchema }),
  z.strictObject({ kind: z.literal("gsv.site.authorization.cancelled"), nonce: z.string(), siteId: siteIdSchema }),
]);

export type SiteClientSession = {
  readonly client: GSVClient;
  readonly expiresAtMs: number;
  /** Disconnects locally. The owner can revoke the credential in their space. */
  close(): void;
};

export type PreparedSiteClient = {
  readonly metadata: Readonly<SiteBootstrap>;
  /** Call directly from a click handler; opens the trusted consent popup synchronously. */
  connect(): Promise<SiteClientSession>;
};

/** Loads this published site's installation binding. No caller-selected gateway is accepted. */
export async function prepareSiteClient(): Promise<PreparedSiteClient> {
  const browser = window;
  const url = new URL("/_gsv/site.json", browser.location.origin);
  if (url.protocol !== "https:") throw new Error("Site authorization requires HTTPS");
  const response = await fetch(url, { credentials: "omit", redirect: "error", cache: "no-store", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("This page is not an available published site");
  const parsed = bootstrapSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.siteOrigin !== browser.location.origin || parsed.data.siteOrigin === parsed.data.gatewayOrigin) {
    throw new Error("The published site identity is invalid");
  }
  const metadata = Object.freeze(parsed.data);
  let pending = false;
  return Object.freeze({
    metadata,
    connect(): Promise<SiteClientSession> {
      if (pending) return Promise.reject(new Error("Site authorization is already in progress"));
      if (browser.location.origin !== metadata.siteOrigin) return Promise.reject(new Error("The published site origin changed"));
      pending = true;
      const nonce = crypto.randomUUID();
      const consent = new URL("/authorize-site", metadata.gatewayOrigin);
      consent.searchParams.set("site", metadata.siteId);
      consent.searchParams.set("nonce", nonce);
      let popup: Window | null;
      try {
        popup = browser.open(consent.href, "_blank", "popup,width=520,height=720");
      } catch (error) {
        pending = false;
        return Promise.reject(error);
      }
      if (!popup) {
        pending = false;
        return Promise.reject(new Error("Allow this page to open the sign-in popup, then try again"));
      }
      return waitForAuthorization(browser, popup, metadata, nonce)
        .then((authorization) => connectSession(browser, metadata, authorization))
        .finally(() => { pending = false; });
    },
  });
}

function waitForAuthorization(browser: Window, popup: Window, metadata: SiteBootstrap, nonce: string): Promise<SiteAuthorization> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (authorization: SiteAuthorization | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(closed);
      browser.removeEventListener("message", message);
      browser.removeEventListener("pagehide", leaving);
      popup.close();
      if (authorization) resolve(authorization);
      else reject(error ?? new Error("Site authorization was cancelled"));
    };
    const message = (event: MessageEvent<unknown>) => {
      if (event.origin !== metadata.gatewayOrigin || event.source !== popup) return;
      const parsed = messageSchema.safeParse(event.data);
      if (!parsed.success || parsed.data.nonce !== nonce) return;
      const data = parsed.data;
      if (data.kind === "gsv.site.authorization.cancelled") {
        if (data.siteId === metadata.siteId) finish(null);
        return;
      }
      const authorization = data.authorization;
      if (authorization.installationId !== metadata.installationId || authorization.siteId !== metadata.siteId
        || authorization.siteOrigin !== metadata.siteOrigin || authorization.gatewayOrigin !== metadata.gatewayOrigin
        || authorization.expiresAtMs <= Date.now() || authorization.expiresAtMs > Date.now() + SESSION_DURATION_MS) {
        finish(null, new Error("The authorization response did not match this site or its session lifetime"));
        return;
      }
      finish(authorization);
    };
    const leaving = () => finish(null);
    const timeout = setTimeout(() => finish(null, new Error("Site authorization timed out")), AUTHORIZATION_TIMEOUT_MS);
    const closed = setInterval(() => { if (popup.closed) finish(null); }, 250);
    browser.addEventListener("message", message);
    browser.addEventListener("pagehide", leaving);
  });
}

async function connectSession(browser: Window, metadata: SiteBootstrap, authorization: SiteAuthorization): Promise<SiteClientSession> {
  const socket = new URL("/ws", metadata.gatewayOrigin);
  socket.protocol = "wss:";
  const client = new GSVClient({ url: socket.href, token: authorization.token,
    peer: { id: `site:${metadata.siteId}:${crypto.randomUUID()}`, platform: "browser" } });
  const close = () => {
    clearTimeout(expiry);
    browser.removeEventListener("pagehide", close);
    client.close();
  };
  const expiry = setTimeout(close, Math.max(0, authorization.expiresAtMs - Date.now()));
  browser.addEventListener("pagehide", close);
  try {
    const connected = await client.connect();
    if (authorization.expiresAtMs <= Date.now() || !sameGrant(connected.peer.grant.calls, CALLS)
      || !sameGrant(connected.peer.grant.signals, SIGNALS) || connected.peer.grant.implements.length !== 0) {
      throw new Error("The connection did not receive the approved site permissions");
    }
    return Object.freeze({ client, expiresAtMs: authorization.expiresAtMs, close });
  } catch (error) {
    close();
    throw error;
  }
}

function sameGrant(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((value) => actual.includes(value));
}
