import { env, SELF } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import type { ManagedSlackPeerEnv } from "../src/managed-peer";
import { workspaceAccountId } from "../src/slack-api";
import { signedSlackRequest } from "./slack-request";

// SAFETY: the managed test configuration binds these Workers and namespaces.
const bindings = env as ManagedSlackPeerEnv & { SLACK_API: Fetcher };
type SlackApiCall = { method: string; body: { channel?: string; text?: string } };

async function pairingCode(previousCode?: string): Promise<string> {
  let code = "";
  await vi.waitFor(async () => {
    const response = await bindings.SLACK_API.fetch("https://slack-api.test/calls");
    const calls = await response.json<SlackApiCall[]>();
    const text = calls.findLast((call) => (
      call.method === "chat.postMessage"
      && call.body.channel === "DALICE01"
      && call.body.text?.includes("Pairing code:")
    ))?.body.text ?? "";
    code = text.match(/[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}/)?.[0]?.replaceAll("-", "") ?? "";
    expect(code).toHaveLength(12);
    if (previousCode) expect(code).not.toBe(previousCode);
  });
  return code;
}

async function sendMessage(eventId: string, ts: string, text: string): Promise<Response> {
  return await SELF.fetch(await signedSlackRequest({
    url: "https://slack.test/slack/events",
    signingSecret: "signing_secret_123456789",
    contentType: "application/json",
    body: JSON.stringify({
      type: "event_callback",
      team_id: "TWORK123",
      api_app_id: "AGSV1234",
      event_id: eventId,
      event_time: Math.floor(Date.now() / 1_000),
      event: { type: "message", user: "UALICE01", channel: "DALICE01", channel_type: "im", text, ts },
    }),
  }));
}

async function confirmPairing(code: string, operationId: string): Promise<string> {
  const pairing = bindings.MANAGED_SLACK_PAIRING.getByName(`pair:${code}`);
  const input = {
    code,
    installationId: "installation-recovery",
    localUid: 1000,
    operationId,
    canonicalOrigin: "https://installation-recovery.gsv.test",
  };
  using prepared = await pairing.prepare(input);
  const activation = { code, operationId, route: prepared.route, canonicalOrigin: input.canonicalOrigin };
  using activated = await pairing.activate(activation);
  using finalized = await pairing.finalize(activation);
  expect(activated.route.generation).toBe(prepared.route.generation);
  expect(finalized.route.generation).toBe(prepared.route.generation);
  return prepared.route.generation;
}

// Recovery replaces the route; keep it in its own per-file storage environment.
it("offers fresh private pairing when the Gateway reports a password-revoked identity", async () => {
  const start = await SELF.fetch(new Request("https://slack.test/slack/install", { redirect: "manual" }));
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("Location")!).searchParams.get("state");
  expect(state).toBeTruthy();
  const cookie = start.headers.get("Set-Cookie")!.split(";", 1)[0];
  const callback = await SELF.fetch(new Request(
    `https://slack.test/slack/oauth/callback?code=test-code&state=${encodeURIComponent(state!)}`,
    { headers: { Cookie: cookie } },
  ));
  expect(callback.status).toBe(200);

  expect((await sendMessage("EvRECOVER1", "1700000501.000001", "hello before recovery")).status).toBe(200);
  const initialCode = await pairingCode();
  using initialCandidate = await bindings.MANAGED_SLACK_PAIRING.getByName(`pair:${initialCode}`).inspect();
  expect(initialCandidate).toMatchObject({
    accountId: await workspaceAccountId("TWORK123"),
    actorId: "UALICE01", surfaceId: "DALICE01", routeScope: "actor", linked: false,
  });
  const initialGeneration = await confirmPairing(initialCode, "before-recovery");

  expect((await sendMessage("EvRECOVER2", "1700000502.000001", "__identity_revoked__")).status).toBe(200);
  const code = await pairingCode(initialCode);
  using candidate = await bindings.MANAGED_SLACK_PAIRING.getByName(`pair:${code}`).inspect();
  expect(candidate).toMatchObject({ actorId: "UALICE01", linked: true });
  const generation = await confirmPairing(code, "after-recovery");
  expect(generation).not.toBe(initialGeneration);

  expect((await sendMessage("EvRECOVER3", "1700000503.000001", "hello after reconnecting")).status).toBe(200);
  await vi.waitFor(async () => {
    const response = await bindings.GATEWAY.fetch("https://gateway.test/calls");
    expect(await response.json()).toContainEqual(expect.objectContaining({
      installation: { installationId: "installation-recovery" },
      call: "adapter.inbound",
      args: expect.objectContaining({
        routeGeneration: generation,
        message: expect.objectContaining({ text: "hello after reconnecting" }),
      }),
    }));
  });
});
