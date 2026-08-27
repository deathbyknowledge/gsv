import {
  exchangeSlackOAuthCode,
  workspaceAccountId,
  type SlackFetch,
} from "./slack-api";
import {
  normalizeSlackEvent,
  parseSlackEventCallback,
  parseSlackUrlVerification,
} from "./slack-events";
import { normalizeSlackInteraction } from "./slack-interactions";
import type { ManagedSlackAcceptedEvent } from "./managed-peer";
import type {
  ManagedSlackWorkspaceAdmission,
} from "./managed-workspace";
import {
  managedSlackPeerObjectName,
  managedSlackWorkspaceObjectName,
} from "./managed-identity";
import { z } from "zod";

type ManagedWorkspaceStub = DurableObjectStub & {
  install(
    accountId: string,
    installation: Awaited<ReturnType<typeof exchangeSlackOAuthCode>>,
  ): Promise<ManagedSlackWorkspaceAdmission>;
  admitEvent(teamId: string): Promise<ManagedSlackWorkspaceAdmission>;
  deactivate(teamId: string): Promise<{ deactivated: boolean }>;
};

type ManagedPeerStub = DurableObjectStub & {
  acceptEvent(input: ManagedSlackAcceptedEvent): Promise<{ accepted: true }>;
  acceptInteraction(input: ManagedSlackAcceptedEvent): Promise<{ accepted: boolean }>;
};

export type ManagedSlackHttpEnv = {
  MANAGED_SLACK_WORKSPACE: Pick<DurableObjectNamespace, "idFromName" | "get">;
  MANAGED_SLACK_PEER: Pick<DurableObjectNamespace, "idFromName" | "get">;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_OAUTH_STATE_SECRET?: string;
  SLACK_PUBLIC_BASE_URL?: string;
  SLACK_API?: Fetcher;
};

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SIGNATURE_WINDOW_SECONDS = 5 * 60;
const OAUTH_COOKIE = "gsv_slack_oauth";
const OAUTH_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "files:read",
  "files:write",
  "im:history",
  "im:write",
].join(",");
const oauthStateSchema = z.object({
  version: z.literal(1),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  issuedAt: z.number().int(),
});
const slackInteractionTeamSchema = z.object({
  team: z.object({ id: z.string() }).passthrough(),
}).passthrough();

export async function handleManagedSlackRequest(
  request: Request,
  env: ManagedSlackHttpEnv,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return Response.json({
      service: "gsv-managed-slack",
      status: "ok",
      configured: managedSlackConfigured(env),
    });
  }
  if (request.method === "GET" && url.pathname === "/slack/install") {
    return await beginSlackOAuth(env);
  }
  if (request.method === "GET" && url.pathname === "/slack/oauth/callback") {
    return await completeSlackOAuth(request, env);
  }
  if (request.method === "POST" && url.pathname === "/slack/events") {
    return await receiveSlackEvent(request, env);
  }
  if (request.method === "POST" && url.pathname === "/slack/interactions") {
    return await receiveSlackInteraction(request, env);
  }
  return new Response("Not Found", { status: 404 });
}

export function managedSlackConfigured(env: ManagedSlackHttpEnv): boolean {
  try {
    requireManagedSlackConfig(env);
    return true;
  } catch {
    return false;
  }
}

export function managedSlackInstallUrl(env: ManagedSlackHttpEnv): string | undefined {
  try {
    return `${requireManagedSlackConfig(env).publicBaseUrl}/slack/install`;
  } catch {
    return undefined;
  }
}

async function beginSlackOAuth(env: ManagedSlackHttpEnv): Promise<Response> {
  let config: ManagedSlackConfig;
  try {
    config = requireManagedSlackConfig(env);
  } catch {
    return new Response("Slack installation is not configured", { status: 503 });
  }
  const nonce = randomBase64Url(24);
  const state = await signOAuthState(
    { version: 1, nonce, issuedAt: Date.now() },
    config.oauthStateSecret,
  );
  const authorize = new URL("https://slack.com/oauth/v2/authorize");
  authorize.searchParams.set("client_id", config.clientId);
  authorize.searchParams.set("scope", OAUTH_SCOPES);
  authorize.searchParams.set("redirect_uri", oauthRedirectUri(config.publicBaseUrl));
  authorize.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Cache-Control": "no-store",
      "Set-Cookie": oauthCookie(nonce, OAUTH_STATE_TTL_MS / 1_000),
    },
  });
}

async function completeSlackOAuth(
  request: Request,
  env: ManagedSlackHttpEnv,
): Promise<Response> {
  let config: ManagedSlackConfig;
  try {
    config = requireManagedSlackConfig(env);
  } catch {
    return oauthHtml("Slack installation is not configured.", 503);
  }
  const url = new URL(request.url);
  if (url.searchParams.get("error")) {
    return oauthHtml("Slack installation was cancelled.", 400, true);
  }
  const code = url.searchParams.get("code")?.trim() ?? "";
  const stateValue = url.searchParams.get("state")?.trim() ?? "";
  const cookieNonce = readCookie(request.headers.get("Cookie"), OAUTH_COOKIE);
  const state = await verifyOAuthState(stateValue, config.oauthStateSecret);
  if (
    !code
    || !state
    || !cookieNonce
    || !constantTimeEqual(cookieNonce, state.nonce)
    || state.issuedAt > Date.now() + 60_000
    || state.issuedAt + OAUTH_STATE_TTL_MS <= Date.now()
  ) {
    return oauthHtml("Slack installation could not be verified. Start again from GSV.", 400, true);
  }

  try {
    const installation = await exchangeSlackOAuthCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri: oauthRedirectUri(config.publicBaseUrl),
    }, slackFetch(env));
    const accountId = await workspaceAccountId(installation.teamId);
    await workspace(env, accountId).install(accountId, installation);
    return oauthHtml(
      `GSV is installed in ${escapeHtml(installation.teamName ?? installation.teamId)}. You can close this tab and mention @GSV in Slack.`,
      200,
      true,
    );
  } catch {
    return oauthHtml("Slack installation failed. Please try again from GSV.", 502, true);
  }
}

async function receiveSlackEvent(
  request: Request,
  env: ManagedSlackHttpEnv,
): Promise<Response> {
  let config: ManagedSlackConfig;
  try {
    config = requireManagedSlackConfig(env);
  } catch {
    await request.body?.cancel("Slack events are not configured").catch(() => undefined);
    return Response.json({ ok: false }, { status: 503 });
  }
  let raw: string;
  try {
    raw = await readBoundedRequestText(request, MAX_REQUEST_BODY_BYTES);
  } catch (error) {
    return slackError(error instanceof BodyTooLargeError ? 413 : 400);
  }
  if (!await verifySlackSignature(request.headers, raw, config.signingSecret)) {
    return slackError(403);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return slackError(400);
  }
  const challenge = parseSlackUrlVerification(payload);
  if (challenge) {
    return Response.json({ challenge }, { headers: { "Cache-Control": "no-store" } });
  }
  const callback = parseSlackEventCallback(payload);
  if (!callback) return slackError(400);

  const accountId = await workspaceAccountId(callback.team_id).catch(() => null);
  if (!accountId) return slackError(400);
  const workspaceStub = workspace(env, accountId);
  let admission: ManagedSlackWorkspaceAdmission;
  try {
    admission = await workspaceStub.admitEvent(callback.team_id);
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
  if (!admission.accepted) return Response.json({ ok: true });

  const normalized = normalizeSlackEvent(payload, admission.botUserId);
  if (normalized.kind === "ignored") return Response.json({ ok: true });
  if (normalized.kind === "invalid") return slackError(400);
  if (normalized.kind === "uninstalled") {
    try {
      await workspaceStub.deactivate(normalized.teamId);
    } catch {
      return Response.json({ ok: false }, { status: 503 });
    }
    return Response.json({ ok: true });
  }

  const inbound = normalized.inbound;
  const id = env.MANAGED_SLACK_PEER.idFromName(
    managedSlackPeerObjectName(admission.accountId, inbound.actorId),
  );
  // SAFETY: the peer namespace is owned by this worker and exposes acceptEvent.
  const peer = env.MANAGED_SLACK_PEER.get(id) as ManagedPeerStub;
  try {
    await peer.acceptEvent({
      accountId: admission.accountId,
      teamId: admission.teamId,
      teamName: admission.teamName,
      botUserId: admission.botUserId,
      workspaceGeneration: admission.generation,
      inbound,
    });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
  return Response.json({ ok: true });
}

async function receiveSlackInteraction(
  request: Request,
  env: ManagedSlackHttpEnv,
): Promise<Response> {
  let config: ManagedSlackConfig;
  try {
    config = requireManagedSlackConfig(env);
  } catch {
    await request.body?.cancel("Slack interactions are not configured").catch(() => undefined);
    return new Response(null, { status: 503 });
  }
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith(
    "application/x-www-form-urlencoded",
  )) {
    await request.body?.cancel("Slack interaction content type is invalid").catch(() => undefined);
    return slackError(400);
  }
  let raw: string;
  try {
    raw = await readBoundedRequestText(request, MAX_REQUEST_BODY_BYTES);
  } catch (error) {
    return slackError(error instanceof BodyTooLargeError ? 413 : 400);
  }
  if (!await verifySlackSignature(request.headers, raw, config.signingSecret)) {
    return slackError(403);
  }
  const params = new URLSearchParams(raw);
  const payloadValues = params.getAll("payload");
  if (payloadValues.length !== 1) return slackError(400);
  let payload: unknown;
  try {
    payload = JSON.parse(payloadValues[0]!);
  } catch {
    return slackError(400);
  }
  const team = slackInteractionTeamSchema.safeParse(payload);
  if (!team.success) return slackError(400);
  const accountId = await workspaceAccountId(team.data.team.id).catch(() => null);
  if (!accountId) return slackError(400);
  const workspaceStub = workspace(env, accountId);
  let admission: ManagedSlackWorkspaceAdmission;
  try {
    admission = await workspaceStub.admitEvent(team.data.team.id);
  } catch {
    return new Response(null, { status: 503 });
  }
  if (!admission.accepted) return new Response(null, { status: 200 });

  const normalized = normalizeSlackInteraction(payload, admission.botUserId);
  if (normalized.kind === "ignored") return new Response(null, { status: 200 });
  if (normalized.kind === "invalid") return slackError(400);
  const inbound = normalized.inbound;
  const id = env.MANAGED_SLACK_PEER.idFromName(
    managedSlackPeerObjectName(admission.accountId, inbound.actorId),
  );
  // SAFETY: the peer namespace is owned by this worker and exposes acceptInteraction.
  const peer = env.MANAGED_SLACK_PEER.get(id) as ManagedPeerStub;
  try {
    await peer.acceptInteraction({
      accountId: admission.accountId,
      teamId: admission.teamId,
      teamName: admission.teamName,
      botUserId: admission.botUserId,
      workspaceGeneration: admission.generation,
      inbound,
    });
  } catch {
    return new Response(null, { status: 503 });
  }
  return new Response(null, { status: 200 });
}

type ManagedSlackConfig = {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  oauthStateSecret: string;
  publicBaseUrl: string;
};

function requireManagedSlackConfig(env: ManagedSlackHttpEnv): ManagedSlackConfig {
  const clientId = env.SLACK_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.SLACK_CLIENT_SECRET?.trim() ?? "";
  const signingSecret = env.SLACK_SIGNING_SECRET?.trim() ?? "";
  const oauthStateSecret = env.SLACK_OAUTH_STATE_SECRET?.trim() ?? "";
  if (!/^[0-9.]{5,100}$/.test(clientId)) throw new Error("Slack client ID is invalid");
  if (clientSecret.length < 16 || clientSecret.length > 512) {
    throw new Error("Slack client secret is invalid");
  }
  if (signingSecret.length < 16 || signingSecret.length > 512) {
    throw new Error("Slack signing secret is invalid");
  }
  if (oauthStateSecret.length < 32 || oauthStateSecret.length > 512) {
    throw new Error("Slack OAuth state secret is invalid");
  }
  const publicUrl = new URL(env.SLACK_PUBLIC_BASE_URL?.trim() ?? "");
  if (
    publicUrl.protocol !== "https:"
    || publicUrl.username
    || publicUrl.password
    || publicUrl.pathname !== "/"
    || publicUrl.search
    || publicUrl.hash
  ) {
    throw new Error("Slack public base URL is invalid");
  }
  return {
    clientId,
    clientSecret,
    signingSecret,
    oauthStateSecret,
    publicBaseUrl: publicUrl.origin,
  };
}

function workspace(env: ManagedSlackHttpEnv, accountId: string): ManagedWorkspaceStub {
  const id = env.MANAGED_SLACK_WORKSPACE.idFromName(
    managedSlackWorkspaceObjectName(accountId),
  );
  // SAFETY: the workspace namespace is owned by this worker and exposes the workspace RPCs.
  return env.MANAGED_SLACK_WORKSPACE.get(id) as ManagedWorkspaceStub;
}

async function verifySlackSignature(
  headers: Headers,
  raw: string,
  signingSecret: string,
): Promise<boolean> {
  const timestamp = headers.get("X-Slack-Request-Timestamp")?.trim() ?? "";
  const presented = headers.get("X-Slack-Signature")?.trim() ?? "";
  if (!/^[0-9]{1,16}$/.test(timestamp) || !/^v0=[0-9a-f]{64}$/.test(presented)) {
    return false;
  }
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(Date.now() / 1_000) - seconds) > SIGNATURE_WINDOW_SECONDS) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${raw}`),
  ));
  const expected = `v0=${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return constantTimeEqual(presented, expected);
}

async function readBoundedRequestText(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get("Content-Length");
  if (declared && (/^[0-9]+$/.test(declared) ? Number(declared) : Infinity) > maxBytes) {
    await request.body?.cancel("Slack request body exceeds limit").catch(() => undefined);
    throw new BodyTooLargeError();
  }
  if (!request.body) throw new Error("Slack request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel("Slack request body exceeds limit").catch(() => undefined);
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

type OAuthState = { version: 1; nonce: string; issuedAt: number };

async function signOAuthState(state: OAuthState, secret: string): Promise<string> {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(state)));
  return `${payload}.${await hmacBase64Url(payload, secret)}`;
}

async function verifyOAuthState(value: string, secret: string): Promise<OAuthState | null> {
  if (value.length > 2_048) return null;
  const [payload, presented, extra] = value.split(".");
  if (!payload || !presented || extra || !constantTimeEqual(presented, await hmacBase64Url(payload, secret))) {
    return null;
  }
  try {
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlBytes(payload)));
    const parsed = oauthStateSchema.safeParse(decoded);
    if (
      !parsed.success
      || !Number.isSafeInteger(parsed.data.issuedAt)
    ) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

async function hmacBase64Url(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  )));
}

function oauthRedirectUri(publicBaseUrl: string): string {
  return `${publicBaseUrl}/slack/oauth/callback`;
}

function oauthCookie(nonce: string, maxAge: number): string {
  return `${OAUTH_COOKIE}=${nonce}; Max-Age=${maxAge}; Path=/slack/oauth/callback; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(header: string | null, name: string): string | null {
  for (const part of header?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function oauthHtml(message: string, status: number, clearCookie = false): Response {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  if (clearCookie) headers.set("Set-Cookie", oauthCookie("deleted", 0));
  return new Response(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><main><h1>GSV for Slack</h1><p>${message}</p></main></body></html>`,
    { status, headers },
  );
}

function slackError(status: number): Response {
  return Response.json(
    { ok: false },
    { status, headers: { "X-Slack-No-Retry": "1", "Cache-Control": "no-store" } },
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function randomBase64Url(length: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(length)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function slackFetch(env: ManagedSlackHttpEnv): SlackFetch {
  return env.SLACK_API
    ? (input, init) => env.SLACK_API!.fetch(input, init)
    : fetch;
}

class BodyTooLargeError extends Error {}
