import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { workspaceAccountId } from "../src/slack-api";
import {
  managedSlackPeerObjectName,
} from "../src/managed-identity";

type SlackApiCall = {
  method: string;
  body: { channel?: string; text?: string; thread_ts?: string; users?: string };
};

type GatewayCall = {
  installation?: { installationId?: string };
  call?: string;
  args?: {
    deliveryId?: string;
    routeGeneration?: string;
    message?: {
      actor?: { id?: string };
      surface?: { kind?: string; id?: string; threadId?: string };
    };
  };
  input?: {
    accountId?: string;
    actorId?: string;
    expectedGeneration?: string;
  };
};

type PairingStub = {
  inspect(): Promise<{
    accountId: string;
    actorId: string;
    surfaceId: string;
    routeScope: string;
  }>;
  prepare(input: PairPrepare): Promise<{
    candidate: { accountId: string; actorId: string; surfaceId: string };
    route: { installationId: string; localUid: number; generation: string };
  }>;
  activate(input: PairActivate): Promise<PairingPreparation>;
  finalize(input: PairActivate): Promise<PairingPreparation>;
};

type PairingPreparation = {
  candidate: { accountId: string; actorId: string; surfaceId: string };
  route: { installationId: string; localUid: number; generation: string };
};

type PairPrepare = {
  code: string;
  installationId: string;
  localUid: number;
  operationId: string;
  canonicalOrigin: string;
};

type PairActivate = {
  code: string;
  operationId: string;
  route: { installationId: string; localUid: number; generation: string };
  canonicalOrigin: string;
};

type PeerStub = {
  sendMessage(
    installationId: string,
    message: {
      deliveryId: string;
      surface: { kind: "channel"; id: string; threadId: string };
      actorId: string;
      routeGeneration: string;
      text: string;
    },
  ): Promise<{ ok: boolean; error?: string }>;
};

const SIGNING_SECRET = "signing_secret_123456789";

function fetcherBinding<T>(value: T): T & Fetcher {
  // SAFETY: these test bindings implement the fetch operation exercised by this flow.
  return value as T & Fetcher;
}

function namespaceBinding<T>(value: T): T & DurableObjectNamespace {
  // SAFETY: these test bindings implement the Durable Object namespace contract.
  return value as T & DurableObjectNamespace;
}

function pairingBinding<T>(value: T): T & PairingStub {
  // SAFETY: the selected Durable Object exposes the pairing RPCs used by this flow.
  return value as T & PairingStub;
}

function peerBinding<T>(value: T): T & PeerStub {
  // SAFETY: the selected Durable Object exposes the peer RPC used by this flow.
  return value as T & PeerStub;
}

async function slackApiCalls(): Promise<SlackApiCall[]> {
  const binding = fetcherBinding(env.SLACK_API);
  return await (await binding.fetch("https://slack-api.test/calls")).json<SlackApiCall[]>();
}

async function gatewayCalls(): Promise<GatewayCall[]> {
  const binding = fetcherBinding(env.GATEWAY);
  return await (await binding.fetch("https://gateway.test/calls")).json<GatewayCall[]>();
}

async function installWorkspace(): Promise<string> {
  const start = await SELF.fetch(new Request("https://slack.test/slack/install", {
    redirect: "manual",
  }));
  expect(start.status).toBe(302);
  const location = new URL(start.headers.get("Location")!);
  const state = location.searchParams.get("state");
  expect(state).toBeTruthy();
  const cookie = start.headers.get("Set-Cookie")!.split(";", 1)[0];
  const callback = await SELF.fetch(new Request(
    `https://slack.test/slack/oauth/callback?code=test-code&state=${encodeURIComponent(state!)}`,
    { headers: { Cookie: cookie } },
  ));
  expect(callback.status).toBe(200);
  return await workspaceAccountId("TWORK123");
}

async function signedEvent(input: {
  eventId: string;
  actorId?: string;
  channelId?: string;
  text?: string;
  ts: string;
  type?: "app_mention" | "message";
  channelType?: "im";
}): Promise<Request> {
  const event = {
    type: input.type ?? "app_mention",
    user: input.actorId ?? "UALICE01",
    channel: input.channelId ?? "CGENERAL1",
    channel_type: input.channelType,
    text: input.text ?? "<@UGSVBOT1> help",
    ts: input.ts,
  };
  const body = JSON.stringify({
    type: "event_callback",
    team_id: "TWORK123",
    api_app_id: "AGSV1234",
    event_id: input.eventId,
    event_time: Math.floor(Date.now() / 1_000),
    event,
  });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  ));
  const signature = `v0=${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return new Request("https://slack.test/slack/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": signature,
    },
    body,
  });
}

async function pairingCodeFor(actorId: string, previousCode?: string): Promise<string> {
  let normalizedCode = "";
  await vi.waitFor(async () => {
    const channel = actorId === "UALICE01" ? "DALICE01" : "DBOB0001";
    const text = (await slackApiCalls()).findLast((call) => (
      call.method === "chat.postMessage"
      && call.body.text?.includes("Pairing code:")
      && call.body.channel === channel
    ))?.body.text ?? "";
    normalizedCode = text
      .match(/[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}/)?.[0]
      ?.replaceAll("-", "") ?? "";
    expect(normalizedCode).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);
    if (previousCode) expect(normalizedCode).not.toBe(previousCode);
  });
  return normalizedCode;
}

function pairingStub(code: string): PairingStub {
  const namespace = namespaceBinding(env.MANAGED_SLACK_PAIRING);
  return pairingBinding(namespace.get(namespace.idFromName(`pair:${code}`)));
}

async function pair(
  actorId: string,
  code: string,
  installationId: string,
  operationId: string,
): Promise<{ generation: string }> {
  const stub = pairingStub(code);
  const candidate = await stub.inspect();
  expect(candidate).toMatchObject({
    accountId: await workspaceAccountId("TWORK123"),
    actorId,
    surfaceId: actorId === "UALICE01" ? "DALICE01" : "DBOB0001",
    routeScope: "actor",
  });
  const input: PairPrepare = {
    code,
    installationId,
    localUid: actorId === "UALICE01" ? 1000 : 1001,
    operationId,
    canonicalOrigin: `https://${installationId}.gsv.test`,
  };
  const prepared = await stub.prepare(input);
  const activation = {
    code,
    operationId,
    route: prepared.route,
    canonicalOrigin: input.canonicalOrigin,
  };
  await stub.activate(activation);
  await stub.finalize(activation);
  return { generation: prepared.route.generation };
}

describe("managed Slack clean-instance flow", () => {
  it("keeps Alice and Bob on their own GSV routes and attributes shared output", async () => {
    const accountId = await installWorkspace();

    expect((await SELF.fetch(await signedEvent({
      eventId: "EvALICE001",
      actorId: "UALICE01",
      ts: "1700000000.000100",
    }))).status).toBe(200);
    const aliceCode = await pairingCodeFor("UALICE01");
    const alice = await pair(
      "UALICE01",
      aliceCode,
      "installation-alice",
      "pair-alice",
    );

    const aliceEvent = await signedEvent({
      eventId: "EvALICE002",
      actorId: "UALICE01",
      text: "<@UGSVBOT1> Alice question",
      ts: "1700000001.000100",
    });
    expect((await SELF.fetch(aliceEvent.clone())).status).toBe(200);
    expect((await SELF.fetch(aliceEvent)).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await gatewayCalls()).toContainEqual(expect.objectContaining({
        installation: { installationId: "installation-alice" },
        call: "adapter.inbound",
        args: expect.objectContaining({
          routeGeneration: alice.generation,
          message: expect.objectContaining({
            actor: expect.objectContaining({ id: "UALICE01" }),
            surface: {
              kind: "channel",
              id: "CGENERAL1",
              threadId: "1700000001.000100",
            },
          }),
        }),
      }));
      expect(await slackApiCalls()).toContainEqual(expect.objectContaining({
        method: "chat.postMessage",
        body: expect.objectContaining({
          channel: "CGENERAL1",
          thread_ts: "1700000001.000100",
          text: "*From <@UALICE01>'s GSV:*\nReply for UALICE01",
        }),
      }));
    });
    expect((await gatewayCalls()).filter((call) => (
      call.args?.deliveryId === "event:EvALICE002"
    ))).toHaveLength(1);

    expect((await SELF.fetch(await signedEvent({
      eventId: "EvBOB00001",
      actorId: "UBOB0001",
      text: "<@UGSVBOT1> Bob setup",
      ts: "1700000002.000100",
    }))).status).toBe(200);
    const bobCode = await pairingCodeFor("UBOB0001");
    const bob = await pair("UBOB0001", bobCode, "installation-bob", "pair-bob");

    expect((await SELF.fetch(await signedEvent({
      eventId: "EvBOB00002",
      actorId: "UBOB0001",
      text: "<@UGSVBOT1> Bob question",
      ts: "1700000003.000100",
    }))).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await gatewayCalls()).toContainEqual(expect.objectContaining({
        installation: { installationId: "installation-bob" },
        args: expect.objectContaining({
          routeGeneration: bob.generation,
          message: expect.objectContaining({
            actor: expect.objectContaining({ id: "UBOB0001" }),
          }),
        }),
      }));
      expect(await slackApiCalls()).toContainEqual(expect.objectContaining({
        method: "chat.postMessage",
        body: expect.objectContaining({
          channel: "CGENERAL1",
          text: "*From <@UBOB0001>'s GSV:*\nReply for UBOB0001",
        }),
      }));
    });

    expect((await SELF.fetch(await signedEvent({
      eventId: "EvALICE003",
      actorId: "UALICE01",
      text: "<@UGSVBOT1> Alice again",
      ts: "1700000004.000100",
    }))).status).toBe(200);
    await vi.waitFor(async () => {
      expect((await gatewayCalls()).filter((call) => (
        call.installation?.installationId === "installation-alice"
        && call.args?.message?.actor?.id === "UALICE01"
      )).length).toBeGreaterThanOrEqual(2);
    });

    expect((await SELF.fetch(await signedEvent({
      eventId: "EvALINK001",
      actorId: "UALICE01",
      channelId: "DALICE01",
      type: "message",
      channelType: "im",
      text: "link",
      ts: "1700000005.000100",
    }))).status).toBe(200);
    const relinkCode = await pairingCodeFor("UALICE01", aliceCode);
    const relinked = await pair(
      "UALICE01",
      relinkCode,
      "installation-alice",
      "relink-alice",
    );
    expect(relinked.generation).not.toBe(alice.generation);
    await vi.waitFor(async () => {
      expect(await gatewayCalls()).toContainEqual(expect.objectContaining({
        call: "unlinkManagedAdapterIdentity",
        installation: { installationId: "installation-alice" },
        input: expect.objectContaining({
          accountId,
          actorId: "UALICE01",
          expectedGeneration: alice.generation,
        }),
      }));
    });

    const peers = namespaceBinding(env.MANAGED_SLACK_PEER);
    const peer = peerBinding(peers.get(
      peers.idFromName(managedSlackPeerObjectName(accountId, "UALICE01")),
    ));
    await expect(peer.sendMessage("installation-alice", {
      deliveryId: "stale-alice-output",
      surface: {
        kind: "channel",
        id: "CGENERAL1",
        threadId: "1700000004.000100",
      },
      actorId: "UALICE01",
      routeGeneration: alice.generation,
      text: "stale output",
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("route changed"),
    });
    expect((await slackApiCalls()).some((call) => call.body.text?.includes("stale output"))).toBe(false);
  });
});
