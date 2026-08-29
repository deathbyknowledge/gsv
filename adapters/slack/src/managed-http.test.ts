import { describe, expect, it, vi } from "vitest";
import {
  handleManagedSlackRequest,
  type ManagedSlackHttpEnv,
} from "./managed-http";
import { workspaceAccountId } from "./slack-api";
import { signedSlackRequest } from "../test/slack-request";

const SIGNING_SECRET = "signing_secret_123456789";
const OAUTH_STATE_SECRET = "oauth_state_secret_12345678901234567890";
type HttpNamespace = Pick<DurableObjectNamespace, "idFromName" | "get">;

function fakeNamespace<T>(value: T): T & HttpNamespace {
  // SAFETY: each fake implements the namespace operations exercised by this HTTP boundary.
  return value as T & HttpNamespace;
}

function fakeFetcher<T>(value: T): T & Fetcher {
  // SAFETY: the fake implements the fetch operation exercised by this HTTP boundary.
  return value as T & Fetcher;
}

async function makeEnv() {
  const accountId = await workspaceAccountId("TWORK123");
  const install = vi.fn(async () => ({ accepted: true as const }));
  const admitEvent = vi.fn(async () => ({
    accepted: true as const,
    accountId,
    teamId: "TWORK123",
    teamName: "Acme",
    botUserId: "UGSVBOT1",
    generation: "workspace-generation",
  }));
  const deactivate = vi.fn(async () => ({ deactivated: true }));
  const acceptEvent = vi.fn(async () => ({ accepted: true as const }));
  const acceptInteraction = vi.fn(async () => ({ accepted: true }));
  const workspaceGet = vi.fn(() => ({ install, admitEvent, deactivate }));
  const peerGet = vi.fn(() => ({ acceptEvent, acceptInteraction }));
  const workspaceIdFromName = vi.fn((name: string) => ({ name }));
  const peerIdFromName = vi.fn((name: string) => ({ name }));
  const slackApi = vi.fn(async () => Response.json({
    ok: true,
    access_token: "xoxb-valid-oauth-bot-token",
    bot_user_id: "UGSVBOT1",
    app_id: "AGSV1234",
    scope: "app_mentions:read,chat:write,chat:write.public,files:read,files:write,im:history,im:write,reactions:write",
    authed_user: {
      id: "UALICE01",
      access_token: "xoxp-valid-oauth-user-token",
      scope: "channels:history,channels:read,groups:history,groups:read,im:history,im:read,mpim:history,mpim:read,users:read",
    },
    is_enterprise_install: false,
    team: { id: "TWORK123", name: "Acme" },
  }));
  const env: ManagedSlackHttpEnv = {
    MANAGED_SLACK_WORKSPACE: fakeNamespace({
      idFromName: workspaceIdFromName,
      get: workspaceGet,
    }),
    MANAGED_SLACK_PEER: fakeNamespace({
      idFromName: peerIdFromName,
      get: peerGet,
    }),
    SLACK_CLIENT_ID: "12345.67890",
    SLACK_CLIENT_SECRET: "client_secret_123456789",
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    SLACK_OAUTH_STATE_SECRET: OAUTH_STATE_SECRET,
    SLACK_PUBLIC_BASE_URL: "https://slack.gsv.test",
    SLACK_API: fakeFetcher({ fetch: slackApi }),
  };
  return {
    env,
    accountId,
    install,
    admitEvent,
    deactivate,
    acceptEvent,
    acceptInteraction,
    workspaceGet,
    peerGet,
    workspaceIdFromName,
    peerIdFromName,
    slackApi,
  };
}

function interactionPayload() {
  return {
    type: "block_actions",
    team: { id: "TWORK123" },
    user: { id: "UALICE01" },
    channel: { id: "DALICE01" },
    container: {
      type: "message",
      channel_id: "DALICE01",
      message_ts: "1700000000.000100",
    },
    message: {
      user: "UGSVBOT1",
      text: "Reply \"approve hil[request-1]\" or \"deny hil[request-1]\".",
      ts: "1700000000.000100",
    },
    actions: [{
      type: "button",
      action_id: "gsv_hil_approve",
      value: JSON.stringify({
        v: 1,
        token: "hil[request-1]",
        routeGeneration: "route-generation-1",
      }),
      action_ts: "1700000001.000200",
    }],
  };
}

function eventPayload(event: { type?: string } = {}) {
  return {
    type: "event_callback",
    team_id: "TWORK123",
    api_app_id: "AGSV1234",
    event_id: "EvEVENT123",
    event_time: Math.floor(Date.now() / 1_000),
    event: {
      type: "app_mention",
      user: "UALICE01",
      channel: "CGENERAL1",
      text: "<@UGSVBOT1> help",
      ts: "1700000000.000100",
      ...event,
    },
  };
}

async function signedEventRequest<T>(payload: T, secret = SIGNING_SECRET): Promise<Request> {
  const body = JSON.stringify(payload);
  return await signedSlackRequest({
    url: "https://slack.gsv.test/slack/events",
    signingSecret: secret,
    contentType: "application/json",
    body,
  });
}

async function signedInteractionRequest<T>(payload: T): Promise<Request> {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  return await signedSlackRequest({
    url: "https://slack.gsv.test/slack/interactions",
    signingSecret: SIGNING_SECRET,
    contentType: "application/x-www-form-urlencoded",
    body,
  });
}

describe("managed Slack HTTP boundary", () => {
  it("rejects an invalid signature before allocating workspace state", async () => {
    const { env, workspaceGet } = await makeEnv();
    const response = await handleManagedSlackRequest(
      await signedEventRequest(eventPayload(), "wrong_signing_secret_123"),
      env,
    );
    expect(response.status).toBe(403);
    expect(workspaceGet).not.toHaveBeenCalled();
  });

  it("answers a signed URL verification without selecting a workspace", async () => {
    const { env, workspaceGet } = await makeEnv();
    const response = await handleManagedSlackRequest(
      await signedEventRequest({ type: "url_verification", challenge: "challenge-value" }),
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ challenge: "challenge-value" });
    expect(workspaceGet).not.toHaveBeenCalled();
  });

  it("admits an installed workspace before allocating the actor peer", async () => {
    const {
      env,
      accountId,
      acceptEvent,
      workspaceIdFromName,
      peerIdFromName,
    } = await makeEnv();
    const response = await handleManagedSlackRequest(
      await signedEventRequest(eventPayload()),
      env,
    );
    expect(response.status).toBe(200);
    expect(workspaceIdFromName).toHaveBeenCalledWith(`workspace:${accountId}`);
    expect(peerIdFromName).toHaveBeenCalledWith(`peer:${accountId}:UALICE01`);
    expect(acceptEvent).toHaveBeenCalledWith(expect.objectContaining({
      accountId,
      teamId: "TWORK123",
      workspaceGeneration: "workspace-generation",
      inbound: expect.objectContaining({
        actorId: "UALICE01",
        surface: expect.objectContaining({ kind: "channel", id: "CGENERAL1" }),
      }),
    }));
  });

  it("deactivates an installed workspace on app_uninstalled", async () => {
    const { env, deactivate, peerGet } = await makeEnv();
    const response = await handleManagedSlackRequest(
      await signedEventRequest(eventPayload({ type: "app_uninstalled" })),
      env,
    );
    expect(response.status).toBe(200);
    expect(deactivate).toHaveBeenCalledWith("TWORK123");
    expect(peerGet).not.toHaveBeenCalled();
  });

  it("durably routes a signed approval interaction to the actor peer", async () => {
    const {
      env,
      accountId,
      acceptInteraction,
      peerIdFromName,
    } = await makeEnv();
    const response = await handleManagedSlackRequest(
      await signedInteractionRequest(interactionPayload()),
      env,
    );
    expect(response.status).toBe(200);
    expect(peerIdFromName).toHaveBeenCalledWith(`peer:${accountId}:UALICE01`);
    expect(acceptInteraction).toHaveBeenCalledWith(expect.objectContaining({
      accountId,
      workspaceGeneration: "workspace-generation",
      inbound: expect.objectContaining({
        actorId: "UALICE01",
        text: "approve hil[request-1]",
        interaction: expect.objectContaining({
          expectedRouteGeneration: "route-generation-1",
        }),
      }),
    }));
  });

  it("binds OAuth callback state to the initiating browser before installing", async () => {
    const { env, accountId, install, slackApi } = await makeEnv();
    const start = await handleManagedSlackRequest(
      new Request("https://slack.gsv.test/slack/install"),
      env,
    );
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("Location")!);
    expect(location.origin).toBe("https://slack.com");
    expect(location.searchParams.get("scope")).toContain("app_mentions:read");
    expect(location.searchParams.get("scope")).toContain("chat:write.public");
    expect(location.searchParams.get("scope")).toContain("reactions:write");
    expect(location.searchParams.get("user_scope")).toContain("channels:history");
    expect(location.searchParams.get("user_scope")).not.toContain("chat:write");
    expect(location.searchParams.get("user_scope")).not.toContain("reactions:write");
    const state = location.searchParams.get("state")!;
    const cookie = start.headers.get("Set-Cookie")!.split(";", 1)[0];
    const callback = new Request(
      `https://slack.gsv.test/slack/oauth/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: cookie } },
    );
    const response = await handleManagedSlackRequest(callback, env);
    expect(response.status).toBe(200);
    expect(slackApi).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith(
      accountId,
      expect.objectContaining({
        teamId: "TWORK123",
        botUserId: "UGSVBOT1",
        user: expect.objectContaining({
          id: "UALICE01",
          token: "xoxp-valid-oauth-user-token",
        }),
      }),
    );
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});
