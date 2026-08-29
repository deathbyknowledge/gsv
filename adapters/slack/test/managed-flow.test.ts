import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { binaryBodyFromOwnedBytes } from "../../shared/src/media-body";
import { workspaceAccountId } from "../src/slack-api";
import {
  managedSlackPeerObjectName,
} from "../src/managed-identity";

type SlackApiCall = {
  method: string;
  body: {
    channel?: string;
    text?: string;
    thread_ts?: string;
    users?: string;
    file?: string;
    files?: Array<{ id: string }>;
    blocks?: Array<{
      type?: string;
      elements?: Array<{ action_id?: string; value?: string }>;
    }>;
    initial_comment?: string;
    ts?: string;
    bytes?: number[];
    authorization?: string;
  };
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
      text?: string;
      media?: Array<{
        type?: string;
        mimeType?: string;
        filename?: string;
        body?: { offset?: number; length?: number };
      }>;
    };
  };
  input?: {
    accountId?: string;
    actorId?: string;
    expectedGeneration?: string;
  };
  mediaBody?: number[];
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
      surface: { kind: "channel" | "dm"; id: string; threadId?: string };
      actorId: string;
      routeGeneration: string;
      text: string;
      media?: Array<{
        type: "document";
        mimeType: string;
        filename: string;
        body: { offset: number; length: number };
      }>;
    },
    body?: ReturnType<typeof binaryBodyFromOwnedBytes>,
  ): Promise<{ ok: boolean; error?: string; messageId?: string }>;
  listTargets(
    installationId: string,
    routeGeneration: string,
  ): Promise<Array<{
    id: string;
    label: string;
    platform: string;
    implements: string[];
  }>>;
  executeTarget(
    installationId: string,
    routeGeneration: string,
    targetId: string,
    frame: {
      type: "req";
      id: string;
      call: "shell.exec";
      args: { input: string; timeout?: number };
      deadlineAt: number;
    },
  ): Promise<{
    type: "res";
    id: string;
    ok: boolean;
    data?: { status: string; output: string; exitCode?: number };
    error?: { code: number; message: string };
  }>;
  cancelTarget(
    installationId: string,
    routeGeneration: string,
    targetId: string,
    requestId: string,
  ): Promise<{ cancelled: boolean }>;
};

const SIGNING_SECRET = "signing_secret_123456789";
const APPROVAL_PROMPT = [
  "I need your confirmation before I can continue.",
  "",
  "Run the requested shell command.",
  "",
  "Reply \"approve hil[managed-request-1]\" to continue, \"approve always hil[managed-request-1]\" to remember it for this conversation, or \"deny hil[managed-request-1]\" to stop this action.",
].join("\n");

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

function peerBinding<T extends object>(value: T): T & Rpc.Provider<PeerStub> {
  // SAFETY: the selected Durable Object exposes the peer RPC used by this flow.
  return value as T & Rpc.Provider<PeerStub>;
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
  subtype?: "file_share";
  files?: Array<{ id: string; size: number }>;
}): Promise<Request> {
  const event = {
    type: input.type ?? "app_mention",
    user: input.actorId ?? "UALICE01",
    channel: input.channelId ?? "CGENERAL1",
    channel_type: input.channelType,
    text: input.text ?? "<@UGSVBOT1> help",
    ts: input.ts,
    subtype: input.subtype,
    files: input.files,
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

async function signedInteraction(input: {
  sourceMessageId: string;
  actionTs: string;
  value: string;
}): Promise<Request> {
  const payload = {
    type: "block_actions",
    team: { id: "TWORK123" },
    user: { id: "UALICE01" },
    channel: { id: "DALICE01" },
    container: {
      type: "message",
      channel_id: "DALICE01",
      message_ts: input.sourceMessageId,
    },
    message: {
      user: "UGSVBOT1",
      text: APPROVAL_PROMPT,
      ts: input.sourceMessageId,
    },
    actions: [{
      type: "button",
      action_id: "gsv_hil_approve",
      value: input.value,
      action_ts: input.actionTs,
    }],
  };
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
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
  return new Request("https://slack.test/slack/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
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

    const peers = namespaceBinding(env.MANAGED_SLACK_PEER);
    const peer = peerBinding(peers.get(
      peers.idFromName(managedSlackPeerObjectName(accountId, "UALICE01")),
    ));
    using targetDescriptors = await peer.listTargets("installation-alice", alice.generation);
    expect(targetDescriptors).toEqual([
      expect.objectContaining({
        id: "workspace",
        label: "Slack — Acme",
        platform: "slack",
        implements: ["shell.exec"],
      }),
    ]);
    using targetList = await peer.executeTarget(
      "installation-alice",
      alice.generation,
      "workspace",
      {
        type: "req",
        id: "target-list",
        call: "shell.exec",
        args: {
          input: "slack conversations list --json | jq -r '.items[0].name'",
          timeout: 120_000,
        },
        deadlineAt: Date.now() + 120_000,
      },
    );
    expect(targetList).toMatchObject({
      ok: true,
      data: { status: "completed", output: "general\n", exitCode: 0 },
    });
    using targetSend = await peer.executeTarget(
      "installation-alice",
      alice.generation,
      "workspace",
      {
        type: "req",
        id: "target-send",
        call: "shell.exec",
        args: {
          input: "printf '%s' 'hello from target' | slack messages send --channel CGENERAL1 --json | jq -r '.channel'",
        },
        deadlineAt: Date.now() + 120_000,
      },
    );
    expect(targetSend).toMatchObject({
      ok: true,
      data: { status: "completed", output: "CGENERAL1\n", exitCode: 0 },
    });
    expect(await slackApiCalls()).toContainEqual(expect.objectContaining({
      method: "chat.postMessage",
      body: expect.objectContaining({
        channel: "CGENERAL1",
        text: "hello from target",
        authorization: "Bearer xoxp-managed-alice-user-token",
      }),
    }));
    const cancelledExecution = peer.executeTarget(
      "installation-alice",
      alice.generation,
      "workspace",
      {
        type: "req",
        id: "target-cancel",
        call: "shell.exec",
        args: { input: "slack conversations list --cursor wait-for-cancel" },
        deadlineAt: Date.now() + 120_000,
      },
    );
    await vi.waitFor(async () => {
      expect(await slackApiCalls()).toContainEqual(expect.objectContaining({
        method: "conversations.list",
        body: expect.objectContaining({ cursor: "wait-for-cancel" }),
      }));
    });
    using cancellation = await peer.cancelTarget(
      "installation-alice",
      alice.generation,
      "workspace",
      "target-cancel",
    );
    expect(cancellation).toEqual({ cancelled: true });
    using cancelledResult = await cancelledExecution;
    expect(cancelledResult).toMatchObject({
      ok: true,
      data: {
        status: "failed",
        error: "Slack target request cancelled",
      },
    });
    const approvalMessage = await peer.sendMessage("installation-alice", {
      deliveryId: "managed-slack-approval-prompt",
      surface: { kind: "dm", id: "DALICE01" },
      actorId: "UALICE01",
      routeGeneration: alice.generation,
      text: APPROVAL_PROMPT,
    });
    expect(approvalMessage).toMatchObject({ ok: true, messageId: expect.any(String) });
    const approvalPost = (await slackApiCalls()).findLast((call) => (
      call.method === "chat.postMessage" && call.body.text === APPROVAL_PROMPT
    ));
    expect(approvalPost?.body.blocks).toMatchObject([
      { type: "section" },
      {
        type: "actions",
        elements: [
          { action_id: "gsv_hil_approve" },
          { action_id: "gsv_hil_approve_always" },
          { action_id: "gsv_hil_deny" },
        ],
      },
    ]);
    const actionBlock = approvalPost?.body.blocks?.find((block) => block.type === "actions");
    const approveValue = actionBlock?.elements?.find(
      (element) => element.action_id === "gsv_hil_approve",
    )?.value;
    expect(approveValue).toBeTruthy();
    expect(JSON.parse(approveValue!)).toMatchObject({
      token: "hil[managed-request-1]",
      routeGeneration: alice.generation,
    });
    expect((await SELF.fetch(await signedInteraction({
      sourceMessageId: approvalMessage.messageId!,
      actionTs: "1700000100.000100",
      value: approveValue!,
    }))).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await gatewayCalls()).toContainEqual(expect.objectContaining({
        installation: { installationId: "installation-alice" },
        args: expect.objectContaining({
          deliveryId: `interaction:${approvalMessage.messageId}:1700000100.000100`,
          routeGeneration: alice.generation,
          message: expect.objectContaining({
            text: "approve hil[managed-request-1]",
          }),
        }),
      }));
      expect(await slackApiCalls()).toContainEqual(expect.objectContaining({
        method: "chat.update",
        body: expect.objectContaining({
          channel: "DALICE01",
          ts: approvalMessage.messageId,
          text: expect.stringContaining("Decision submitted: Approve once."),
        }),
      }));
    });

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

    const inboundFileBytes = new TextEncoder().encode("managed inbound file");
    expect((await SELF.fetch(await signedEvent({
      eventId: "EvALFILE01",
      actorId: "UALICE01",
      text: "<@UGSVBOT1> inspect this",
      ts: "1700000001.000200",
      subtype: "file_share",
      files: [{ id: "FFILE001", size: inboundFileBytes.byteLength }],
    }))).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await gatewayCalls()).toContainEqual(expect.objectContaining({
        installation: { installationId: "installation-alice" },
        args: expect.objectContaining({
          deliveryId: "event:EvALFILE01",
          message: expect.objectContaining({
            media: [{
              type: "document",
              mimeType: "text/plain",
              filename: "managed.txt",
              size: inboundFileBytes.byteLength,
              body: { offset: 0, length: inboundFileBytes.byteLength },
            }],
          }),
        }),
        mediaBody: [...inboundFileBytes],
      }));
      expect(await slackApiCalls()).toContainEqual({
        method: "file.download",
        body: { authorization: "Bearer xoxb-managed-test-token" },
      });
    });

    const outboundFileBytes = new TextEncoder().encode("managed outbound file");
    const mediaPeers = namespaceBinding(env.MANAGED_SLACK_PEER);
    const mediaPeer = peerBinding(mediaPeers.get(
      mediaPeers.idFromName(managedSlackPeerObjectName(accountId, "UALICE01")),
    ));
    await expect(mediaPeer.sendMessage("installation-alice", {
      deliveryId: "managed-slack-file-output",
      surface: {
        kind: "channel",
        id: "CGENERAL1",
        threadId: "1700000001.000200",
      },
      actorId: "UALICE01",
      routeGeneration: alice.generation,
      text: "File result",
      media: [{
        type: "document",
        mimeType: "text/plain",
        filename: "result.txt",
        body: { offset: 0, length: outboundFileBytes.byteLength },
      }],
    }, binaryBodyFromOwnedBytes(outboundFileBytes.slice()))).resolves.toEqual({
      ok: true,
      messageId: "FUPLOAD1",
    });
    expect(await slackApiCalls()).toContainEqual({
      method: "file.upload",
      body: { bytes: [...outboundFileBytes] },
    });
    expect(await slackApiCalls()).toContainEqual(expect.objectContaining({
      method: "files.completeUploadExternal",
      body: expect.objectContaining({
        files: [{ id: "FUPLOAD1" }],
        initial_comment: "*From <@UALICE01>'s GSV:*\nFile result",
        thread_ts: "1700000001.000200",
      }),
    }));

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

    const approvalCallsBeforeStaleClick = (await gatewayCalls()).filter((call) => (
      call.args?.message?.text === "approve hil[managed-request-1]"
    )).length;
    expect((await SELF.fetch(await signedInteraction({
      sourceMessageId: approvalMessage.messageId!,
      actionTs: "1700000101.000100",
      value: approveValue!,
    }))).status).toBe(200);
    expect((await gatewayCalls()).filter((call) => (
      call.args?.message?.text === "approve hil[managed-request-1]"
    ))).toHaveLength(approvalCallsBeforeStaleClick);
  });
});
