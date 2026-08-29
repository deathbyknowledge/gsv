import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { binaryBodyFromOwnedBytes } from "../../shared/src/media-body";
import { workspaceAccountId } from "../src/slack-api";
import type { ManagedSlackPeer } from "../src/managed-peer";
import type { ManagedSlackPeerState } from "../src/managed-peer-state";
import {
  managedSlackPeerObjectName,
  managedSlackWorkspaceObjectName,
} from "../src/managed-identity";
import { managedSlackTargetRequestSchema } from "../src/managed";
import { signedSlackRequest } from "./slack-request";

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
    types?: string;
    bytes?: number[];
    authorization?: string;
  };
};

type GatewayCall = {
  installation?: { installationId?: string };
  call?: string;
  args?: {
    adapter?: string;
    accountId?: string;
    deliveryId?: string;
    routeGeneration?: string;
    status?: {
      connected?: boolean;
      authenticated?: boolean;
      mode?: string;
      error?: string;
    };
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
      runId?: string;
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

type WorkspaceStub = {
  install(
    accountId: string,
    installation: {
      teamId: string;
      teamName: string;
      botUserId: string;
      botToken: string;
      scope: string;
      user: { id: string; token: string; scope: string };
    },
  ): Promise<{ accepted: true; generation: string }>;
  getStatus(): Promise<{ connected: boolean }>;
  getTargetAuthorization(
    actorId: string,
    generation: string,
  ): Promise<{ available: boolean }>;
};

type ManagedPeerRaceHarness = Pick<ManagedSlackPeer, "disconnect" | "executeTarget"> & {
  requireCurrentTargetRoute(
    installationId: string,
    routeGeneration: string,
  ): Promise<ManagedSlackPeerState>;
};

type TargetFrame = Parameters<PeerStub["executeTarget"]>[3];

const SIGNING_SECRET = "signing_secret_123456789";
const APPROVAL_PROMPT = [
  "I need your confirmation before I can continue.",
  "",
  "Run the requested shell command.",
  "",
  "Reply \"approve hil[managed-request-1]\" to continue, \"approve always hil[managed-request-1]\" to remember it for this conversation, or \"deny hil[managed-request-1]\" to stop this action.",
].join("\n");

function targetFrame(
  id: string,
  input: string,
  options: { runId?: string; timeout?: number } = {},
): TargetFrame {
  return {
    type: "req",
    id,
    call: "shell.exec",
    runId: options.runId,
    args: { input, timeout: options.timeout },
    deadlineAt: Date.now() + (options.timeout ?? 120_000),
  };
}

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

function managedPeerObject(value: DurableObjectStub): DurableObjectStub<ManagedSlackPeer> {
  // SAFETY: the stub comes from MANAGED_SLACK_PEER using its canonical object name.
  return value as DurableObjectStub<ManagedSlackPeer>;
}

function managedPeerRaceHarness(value: ManagedSlackPeer): ManagedPeerRaceHarness {
  // SAFETY: this test harness exposes the peer's existing private route-admission seam.
  return value as ManagedPeerRaceHarness;
}

function workspaceBinding<T extends object>(value: T): T & Rpc.Provider<WorkspaceStub> {
  // SAFETY: the selected Durable Object exposes the workspace RPCs used by this flow.
  return value as T & Rpc.Provider<WorkspaceStub>;
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
  return await signedSlackRequest({
    url: "https://slack.test/slack/events",
    signingSecret: SIGNING_SECRET,
    contentType: "application/json",
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
  return await signedSlackRequest({
    url: "https://slack.test/slack/interactions",
    signingSecret: SIGNING_SECRET,
    contentType: "application/x-www-form-urlencoded",
    body,
  });
}

async function signedUninstall(): Promise<Request> {
  const body = JSON.stringify({
    type: "event_callback",
    team_id: "TWORK123",
    api_app_id: "AGSV1234",
    event_id: "EvUNINST01",
    event_time: Math.floor(Date.now() / 1_000),
    event: { type: "app_uninstalled" },
  });
  return await signedSlackRequest({
    url: "https://slack.test/slack/events",
    signingSecret: SIGNING_SECRET,
    contentType: "application/json",
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

function peerFor(accountId: string, actorId: string): Rpc.Provider<PeerStub> {
  const peers = namespaceBinding(env.MANAGED_SLACK_PEER);
  return peerBinding(peers.get(
    peers.idFromName(managedSlackPeerObjectName(accountId, actorId)),
  ));
}

async function pairActor(input: {
  actorId: string;
  eventId: string;
  ts: string;
  installationId: string;
  operationId: string;
  previousCode?: string;
}): Promise<{ code: string; generation: string }> {
  expect((await SELF.fetch(await signedEvent({
    eventId: input.eventId,
    actorId: input.actorId,
    ts: input.ts,
  }))).status).toBe(200);
  const code = await pairingCodeFor(input.actorId, input.previousCode);
  return {
    code,
    ...await pair(input.actorId, code, input.installationId, input.operationId),
  };
}

async function sendApproval(
  peer: Rpc.Provider<PeerStub>,
  routeGeneration: string,
  deliveryId: string,
): Promise<{ messageId: string; approveValue: string }> {
  const approvalMessage = await peer.sendMessage("installation-alice", {
    deliveryId,
    surface: { kind: "dm", id: "DALICE01" },
    actorId: "UALICE01",
    routeGeneration,
    text: APPROVAL_PROMPT,
  });
  expect(approvalMessage).toMatchObject({ ok: true, messageId: expect.any(String) });
  const approvalPost = (await slackApiCalls()).findLast((call) => (
    call.method === "chat.postMessage" && call.body.text === APPROVAL_PROMPT
  ));
  const actionBlock = approvalPost?.body.blocks?.find((block) => block.type === "actions");
  const approveValue = actionBlock?.elements?.find(
    (element) => element.action_id === "gsv_hil_approve",
  )?.value;
  expect(approveValue).toBeTruthy();
  expect(JSON.parse(approveValue!)).toMatchObject({
    token: "hil[managed-request-1]",
    routeGeneration,
  });
  return { messageId: approvalMessage.messageId!, approveValue: approveValue! };
}

describe("managed Slack clean-instance flow", () => {
  it("fences a target call while its route admission is in flight", async () => {
    const teamId = "TRACE123";
    const actorId = "URACE001";
    const accountId = await workspaceAccountId(teamId);
    const workspaces = namespaceBinding(env.MANAGED_SLACK_WORKSPACE);
    const workspace = workspaceBinding(workspaces.get(
      workspaces.idFromName(managedSlackWorkspaceObjectName(accountId)),
    ));
    using installed = await workspace.install(accountId, {
      teamId,
      teamName: "Race Test",
      botUserId: "UBOTRACE1",
      botToken: "xoxb-managed-race-bot-token",
      scope: "app_mentions:read,chat:write,chat:write.public,files:read,files:write,im:history,im:write,reactions:write",
      user: {
        id: actorId,
        token: "xoxp-managed-race-user-token",
        scope: "channels:history,channels:read,groups:history,groups:read,im:history,im:read,mpim:history,mpim:read,users:read",
      },
    });
    const route = {
      installationId: "installation-race",
      localUid: 1000,
      generation: "route-race-old",
      canonicalOrigin: "https://installation-race.gsv.test",
      linkedAt: Date.now(),
    };
    const peers = namespaceBinding(env.MANAGED_SLACK_PEER);
    const peer = managedPeerObject(peers.get(
      peers.idFromName(managedSlackPeerObjectName(accountId, actorId)),
    ));
    await runInDurableObject(peer, async (_instance, state) => {
      await state.storage.put("managed_slack_peer:v1:state", {
        version: 1,
        accountId,
        teamId,
        teamName: "Race Test",
        botUserId: "UBOTRACE1",
        workspaceGeneration: installed.generation,
        actorId,
        dmSurfaceId: "DRACE001",
        observedSurfaces: [],
        activeRoute: route,
      } satisfies ManagedSlackPeerState);
    });

    const result = await runInDurableObject(peer, async (instance) => {
      const harness = managedPeerRaceHarness(instance);
      const original = harness.requireCurrentTargetRoute;
      let releaseAdmission!: () => void;
      const admissionReleased = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      let routeAdmitted!: () => void;
      const routeWasAdmitted = new Promise<void>((resolve) => {
        routeAdmitted = resolve;
      });
      harness.requireCurrentTargetRoute = async (installationId, routeGeneration) => {
        const state = await original.call(instance, installationId, routeGeneration);
        routeAdmitted();
        await admissionReleased;
        return state;
      };
      try {
        const execution = harness.executeTarget(
          route.installationId,
          route.generation,
          "workspace",
          targetFrame(
            "target-route-race",
            "slack messages send --channel CRACE001 --message 'stale route mutation'",
          ),
        );
        await routeWasAdmitted;
        await harness.disconnect({
          operationId: "disconnect-route-race",
          installationId: route.installationId,
          accountId,
          actorId,
          surfaceId: "DRACE001",
          localUid: route.localUid,
          generation: route.generation,
        });
        releaseAdmission();
        return await execution;
      } finally {
        releaseAdmission();
        harness.requireCurrentTargetRoute = original;
      }
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 409,
        message: "Slack target route changed during execution",
      },
    });
    expect((await slackApiCalls()).some((call) => (
      call.method === "chat.postMessage" && call.body.text === "stale route mutation"
    ))).toBe(false);
  });

  it("keeps transport connected while target-specific app scopes await reauthorization", async () => {
    const accountId = await workspaceAccountId("TLEGACY1");
    const workspaces = namespaceBinding(env.MANAGED_SLACK_WORKSPACE);
    const workspace = workspaceBinding(workspaces.get(
      workspaces.idFromName(managedSlackWorkspaceObjectName(accountId)),
    ));
    using installed = await workspace.install(accountId, {
      teamId: "TLEGACY1",
      teamName: "Legacy",
      botUserId: "UGSVBOT1",
      botToken: "xoxb-legacy-bot-token-value",
      scope: "app_mentions:read,chat:write,files:read,files:write,im:history,im:write",
      user: {
        id: "UALICE01",
        token: "xoxp-legacy-user-token-value",
        scope: "channels:history,channels:read,groups:history,groups:read,im:history,im:read,mpim:history,mpim:read,users:read",
      },
    });

    using status = await workspace.getStatus();
    expect(status).toEqual(expect.objectContaining({ connected: true }));
    using target = await workspace.getTargetAuthorization(
      "UALICE01",
      installed.generation,
    );
    expect(target).toEqual({ available: false });
  });

  it("exposes an authorized and cancellable Slack target", async () => {
    const accountId = await installWorkspace();
    const alice = await pairActor({
      actorId: "UALICE01",
      eventId: "EvALICE001",
      ts: "1700000000.000100",
      installationId: "installation-alice",
      operationId: "pair-alice",
    });
    const peer = peerFor(accountId, "UALICE01");
    using targetDescriptors = await peer.listTargets("installation-alice", alice.generation);
    expect(targetDescriptors).toEqual([
      expect.objectContaining({
        id: "workspace",
        label: "Slack — Acme",
        description: "Slack workspace: reads with the paired user's OAuth visibility; writes as the installed GSV app and labels target messages with that user's GSV. Run `slack --help` for commands.",
        platform: "slack",
        implements: ["shell.exec"],
      }),
    ]);
    const targetListFrame = targetFrame(
      "target-list",
      "slack conversations list --json | jq -r '.items[0].name'",
      { runId: "process-run-target-list", timeout: 120_000 },
    );
    expect(managedSlackTargetRequestSchema.safeParse(targetListFrame).success).toBe(true);
    using targetList = await peer.executeTarget(
      "installation-alice",
      alice.generation,
      "workspace",
      targetListFrame,
    );
    expect(targetList).toMatchObject({
      ok: true,
      data: { status: "completed", output: "general\n", exitCode: 0 },
    });
    using targetDmList = await peer.executeTarget(
      "installation-alice",
      alice.generation,
      "workspace",
      targetFrame(
        "target-dm-list",
        "slack conversations list --types im --json | jq -r '.items[0] | [.kind, .id, .userId] | @tsv'",
      ),
    );
    expect(targetDmList).toMatchObject({
      ok: true,
      data: { status: "completed", output: "im\tDGSVBOT1\tUGSVBOT1\n", exitCode: 0 },
    });
    expect(await slackApiCalls()).toContainEqual(expect.objectContaining({
      method: "conversations.list",
      body: expect.objectContaining({
        types: "im",
        authorization: "Bearer xoxp-managed-alice-user-token",
      }),
    }));
    using targetIdentity = await peer.executeTarget(
      "installation-alice",
      alice.generation,
      "workspace",
      targetFrame(
        "target-identity",
        "slack whoami --json | jq -r '[.reader.id, .writer.kind, .writer.id] | @tsv'",
      ),
    );
    expect(targetIdentity).toMatchObject({
      ok: true,
      data: {
        status: "completed",
        output: "UALICE01\tapp\tUGSVBOT1\n",
        exitCode: 0,
      },
    });
    using targetSend = await peer.executeTarget(
      "installation-alice",
      alice.generation,
      "workspace",
      targetFrame(
        "target-send",
        "printf '%s' 'hello from target' | slack messages send --channel CGENERAL1 --json | jq -r '.channel'",
      ),
    );
    expect(targetSend).toMatchObject({
      ok: true,
      data: { status: "completed", output: "CGENERAL1\n", exitCode: 0 },
    });
    expect(await slackApiCalls()).toContainEqual(expect.objectContaining({
      method: "chat.postMessage",
      body: expect.objectContaining({
        channel: "CGENERAL1",
        text: "*From <@UALICE01>'s GSV:*\nhello from target",
        authorization: "Bearer xoxb-managed-test-token",
      }),
    }));
    using targetReaction = await peer.executeTarget(
      "installation-alice",
      alice.generation,
      "workspace",
      targetFrame(
        "target-reaction",
        "slack reactions add --channel CGENERAL1 --timestamp 1700000001.000100 --name eyes",
      ),
    );
    expect(targetReaction).toMatchObject({
      ok: true,
      data: {
        status: "completed",
        output: "reacted eyes to CGENERAL1 1700000001.000100\n",
        exitCode: 0,
      },
    });
    expect(await slackApiCalls()).toContainEqual(expect.objectContaining({
      method: "reactions.add",
      body: expect.objectContaining({
        channel: "CGENERAL1",
        authorization: "Bearer xoxb-managed-test-token",
      }),
    }));
    expect((await slackApiCalls()).filter((call) => (
      call.method === "conversations.info"
      && call.body.channel === "CGENERAL1"
      && call.body.authorization === "Bearer xoxp-managed-alice-user-token"
    )).length).toBeGreaterThanOrEqual(4);

    using deniedTargetSend = await peer.executeTarget(
      "installation-alice",
      alice.generation,
      "workspace",
      targetFrame(
        "target-denied-send",
        "slack messages send --channel CBOTONLY1 --message 'not authorized'",
      ),
    );
    expect(deniedTargetSend).toMatchObject({
      ok: true,
      data: {
        status: "failed",
        error: expect.stringContaining("channel_not_found"),
      },
    });
    using deniedTargetReaction = await peer.executeTarget(
      "installation-alice",
      alice.generation,
      "workspace",
      targetFrame(
        "target-denied-reaction",
        "slack reactions add --channel CBOTONLY1 --timestamp 1700000001.000100 --name eyes",
      ),
    );
    expect(deniedTargetReaction).toMatchObject({
      ok: true,
      data: {
        status: "failed",
        error: expect.stringContaining("channel_not_found"),
      },
    });
    expect((await slackApiCalls()).some((call) => (
      call.body.channel === "CBOTONLY1"
      && (call.method === "chat.postMessage" || call.method === "reactions.add")
    ))).toBe(false);
    const cancelledExecution = peer.executeTarget(
      "installation-alice",
      alice.generation,
      "workspace",
      targetFrame(
        "target-cancel",
        "slack conversations list --cursor wait-for-cancel",
      ),
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
  });

  it("routes paired ingress, approvals, and media without duplicate delivery", async () => {
    const accountId = await installWorkspace();
    const alice = await pairActor({
      actorId: "UALICE01",
      eventId: "EvALICE001",
      ts: "1700000000.000100",
      installationId: "installation-alice",
      operationId: "pair-alice",
    });
    const peer = peerFor(accountId, "UALICE01");
    const approval = await sendApproval(
      peer,
      alice.generation,
      "managed-slack-approval-prompt",
    );
    expect((await SELF.fetch(await signedInteraction({
      sourceMessageId: approval.messageId,
      actionTs: "1700000100.000100",
      value: approval.approveValue,
    }))).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await gatewayCalls()).toContainEqual(expect.objectContaining({
        installation: { installationId: "installation-alice" },
        args: expect.objectContaining({
          deliveryId: `interaction:${approval.messageId}:1700000100.000100`,
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
          ts: approval.messageId,
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
    await expect(peer.sendMessage("installation-alice", {
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

    await expect(peer.sendMessage("installation-alice", {
      deliveryId: "managed-slack-file-membership-failure",
      surface: {
        kind: "channel",
        id: "CGENERAL1",
        threadId: "1700000001.000200",
      },
      actorId: "UALICE01",
      routeGeneration: alice.generation,
      text: "Membership failure",
      media: [{
        type: "document",
        mimeType: "text/plain",
        filename: "result.txt",
        body: { offset: 0, length: outboundFileBytes.byteLength },
      }],
    }, binaryBodyFromOwnedBytes(outboundFileBytes.slice()))).resolves.toEqual({
      ok: false,
      error: "Invite the GSV app to this Slack conversation before sharing files",
    });
  });

  it("isolates actor routes and fences relink, reinstall, and uninstall transitions", async () => {
    const accountId = await installWorkspace();
    const alice = await pairActor({
      actorId: "UALICE01",
      eventId: "EvALICE001",
      ts: "1700000000.000100",
      installationId: "installation-alice",
      operationId: "pair-alice",
    });
    const peer = peerFor(accountId, "UALICE01");

    expect((await SELF.fetch(await signedEvent({
      eventId: "EvALICE002",
      actorId: "UALICE01",
      text: "<@UGSVBOT1> Alice question",
      ts: "1700000001.000100",
    }))).status).toBe(200);
    await vi.waitFor(async () => {
      expect(await gatewayCalls()).toContainEqual(expect.objectContaining({
        installation: { installationId: "installation-alice" },
        args: expect.objectContaining({
          routeGeneration: alice.generation,
          message: expect.objectContaining({
            actor: expect.objectContaining({ id: "UALICE01" }),
          }),
        }),
      }));
    });
    const approval = await sendApproval(
      peer,
      alice.generation,
      "managed-slack-stale-approval-prompt",
    );

    const bob = await pairActor({
      actorId: "UBOB0001",
      eventId: "EvBOB00001",
      ts: "1700000002.000100",
      installationId: "installation-bob",
      operationId: "pair-bob",
    });

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
    const relinkCode = await pairingCodeFor("UALICE01", alice.code);
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
      sourceMessageId: approval.messageId,
      actionTs: "1700000101.000100",
      value: approval.approveValue,
    }))).status).toBe(200);
    expect((await gatewayCalls()).filter((call) => (
      call.args?.message?.text === "approve hil[managed-request-1]"
    ))).toHaveLength(approvalCallsBeforeStaleClick);

    const workspaces = namespaceBinding(env.MANAGED_SLACK_WORKSPACE);
    const workspace = workspaceBinding(workspaces.get(
      workspaces.idFromName(managedSlackWorkspaceObjectName(accountId)),
    ));
    const callsBeforeReinstall = (await gatewayCalls()).length;
    using reinstalled = await workspace.install(accountId, {
      teamId: "TWORK123",
      teamName: "Acme",
      botUserId: "UGSVBOT1",
      botToken: "xoxb-managed-rotated-token",
      scope: "app_mentions:read,chat:write,chat:write.public,files:read,files:write,im:history,im:write,reactions:write",
      user: {
        id: "UALICE01",
        token: "xoxp-managed-alice-rotated-token",
        scope: "channels:history,channels:read,groups:history,groups:read,im:history,im:read,mpim:history,mpim:read,users:read",
      },
    });
    expect(reinstalled.generation).toBeTruthy();
    using targetsAfterReinstall = await peer.listTargets(
      "installation-alice",
      relinked.generation,
    );
    expect(targetsAfterReinstall).toEqual([
      expect.objectContaining({ id: "workspace", implements: ["shell.exec"] }),
    ]);
    using identityAfterReinstall = await peer.executeTarget(
      "installation-alice",
      relinked.generation,
      "workspace",
      targetFrame(
        "target-after-reinstall",
        "slack whoami --json | jq -r '.reader.id'",
      ),
    );
    expect(identityAfterReinstall).toMatchObject({
      ok: true,
      data: { status: "completed", output: "UALICE01\n", exitCode: 0 },
    });
    expect(await slackApiCalls()).toContainEqual(expect.objectContaining({
      method: "auth.test",
      body: expect.objectContaining({
        authorization: "Bearer xoxp-managed-alice-rotated-token",
      }),
    }));
    const reinstallCalls = (await gatewayCalls()).slice(callsBeforeReinstall);
    expect(reinstallCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        installation: { installationId: "installation-alice" },
        call: "adapter.state.update",
        args: expect.objectContaining({ status: expect.objectContaining({ connected: true }) }),
      }),
      expect.objectContaining({
        installation: { installationId: "installation-bob" },
        call: "adapter.state.update",
        args: expect.objectContaining({ status: expect.objectContaining({ connected: true }) }),
      }),
    ]));

    const callsBeforeUninstall = (await gatewayCalls()).length;
    expect((await SELF.fetch(await signedUninstall())).status).toBe(200);
    await vi.waitFor(async () => {
      const uninstallCalls = (await gatewayCalls()).slice(callsBeforeUninstall);
      expect(uninstallCalls).toEqual(expect.arrayContaining([
        expect.objectContaining({
          installation: { installationId: "installation-alice" },
          call: "adapter.state.update",
          args: expect.objectContaining({
            status: expect.objectContaining({ connected: false }),
          }),
        }),
        expect.objectContaining({
          installation: { installationId: "installation-bob" },
          call: "adapter.state.update",
          args: expect.objectContaining({
            status: expect.objectContaining({ connected: false }),
          }),
        }),
      ]));
    });
    using unavailableTargets = await peer.listTargets(
      "installation-alice",
      relinked.generation,
    );
    expect(unavailableTargets).toEqual([]);
  });
});
