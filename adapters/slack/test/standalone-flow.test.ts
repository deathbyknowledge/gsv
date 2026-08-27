import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { binaryBodyFromOwnedBytes } from "../../shared/src/media-body";

type AccountStub = {
  start(botToken: string, appToken: string, accountId: string): Promise<void>;
  stop(): Promise<void>;
  getStatus(): Promise<{
    accountId: string;
    connected: boolean;
    authenticated: boolean;
    mode: string;
  }>;
  sendMessage(
    message: {
      deliveryId: string;
      surface: { kind: "channel" | "dm"; id: string; threadId?: string };
      actorId: string;
      text: string;
      media?: Array<{
        type: "document";
        mimeType: string;
        filename: string;
        body: { offset: number; length: number };
      }>;
    },
    body?: ReturnType<typeof binaryBodyFromOwnedBytes>,
  ): Promise<{ ok: boolean; messageId?: string }>;
};

type GatewayCall = {
  installation?: { installationId?: string };
  call?: string;
  args?: {
    adapter?: string;
    accountId?: string;
    deliveryId?: string;
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
  mediaBody?: number[];
};

type SlackApiCall = {
  method?: string;
  body?: {
    channel?: string;
    text?: string;
    thread_ts?: string;
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

const APPROVAL_PROMPT = [
  "I need your confirmation before I can continue.",
  "",
  "Run the requested shell command.",
  "",
  "Reply \"approve hil[standalone-request-1]\" to continue, \"approve always hil[standalone-request-1]\" to remember it for this conversation, or \"deny hil[standalone-request-1]\" to stop this action.",
].join("\n");

function fetcherBinding<T>(value: T): T & Fetcher {
  // SAFETY: these test bindings implement the fetch operation exercised by this flow.
  return value as T & Fetcher;
}

function namespaceBinding<T>(value: T): T & DurableObjectNamespace {
  // SAFETY: this test binding implements the Durable Object namespace contract.
  return value as T & DurableObjectNamespace;
}

function accountBinding<T>(value: T): T & AccountStub {
  // SAFETY: the selected Durable Object exposes the AccountStub RPCs used by this flow.
  return value as T & AccountStub;
}

async function gatewayCalls(): Promise<GatewayCall[]> {
  return await (await fetcherBinding(env.GATEWAY).fetch("https://gateway.test/calls"))
    .json<GatewayCall[]>();
}

async function slackApiCalls(): Promise<SlackApiCall[]> {
  return await (await fetcherBinding(env.SLACK_API).fetch("https://slack-api.test/calls"))
    .json<SlackApiCall[]>();
}

async function socketState(): Promise<{
  acknowledgements: Array<{ envelope_id?: string }>;
  connections: number;
}> {
  return await (await fetcherBinding(env.SLACK_SOCKET).fetch("https://socket.test/state"))
    .json<{ acknowledgements: Array<{ envelope_id?: string }>; connections: number }>();
}

function account(): AccountStub {
  const namespace = namespaceBinding(env.SLACK_ACCOUNT);
  return accountBinding(namespace.get(namespace.idFromName("default")));
}

describe("standalone Slack clean-instance flow", () => {
  it("connects Socket Mode, durably acknowledges ingress, replies, and disconnects", async () => {
    const slack = account();
    await slack.start(
      "xoxb-standalone-test-token",
      "xapp-standalone-test-token",
      "default",
    );
    await expect(slack.getStatus()).resolves.toMatchObject({
      accountId: "default",
      connected: true,
      authenticated: true,
      mode: "socket-mode",
    });

    // Restarting replaces the socket. A late close from the old socket must not
    // mark the new connection offline.
    await slack.start(
      "xoxb-standalone-test-token",
      "xapp-standalone-test-token",
      "default",
    );
    await vi.waitFor(async () => {
      expect(await slack.getStatus()).toMatchObject({
        connected: true,
        authenticated: true,
      });
      expect((await socketState()).connections).toBe(1);
    });

    await vi.waitFor(async () => {
      expect((await socketState()).acknowledgements).toContainEqual({
        envelope_id: "socket-envelope-2",
      });
      expect(await gatewayCalls()).toContainEqual(expect.objectContaining({
        installation: { installationId: "singleton" },
        call: "adapter.inbound",
        args: expect.objectContaining({
          adapter: "slack",
          accountId: "default",
          deliveryId: "event:EvSTAND002",
          message: expect.objectContaining({
            actor: { id: "UALICE01" },
            surface: {
              kind: "channel",
              id: "CGENERAL1",
              threadId: "1700000000.000102",
            },
            media: [{
              type: "document",
              mimeType: "text/plain",
              filename: "standalone.txt",
              size: 23,
              body: { offset: 0, length: 23 },
            }],
          }),
        }),
        mediaBody: [...new TextEncoder().encode("standalone inbound file")],
      }));
      expect(await slackApiCalls()).toContainEqual(expect.objectContaining({
        method: "chat.postMessage",
        body: expect.objectContaining({
          channel: "CGENERAL1",
          thread_ts: "1700000000.000102",
          text: "*From <@UALICE01>'s GSV:*\nStandalone reply",
        }),
      }));
    });

    const approvalMessage = await slack.sendMessage({
      deliveryId: "standalone-slack-approval-prompt",
      surface: { kind: "dm", id: "DALICE01" },
      actorId: "UALICE01",
      text: APPROVAL_PROMPT,
    });
    expect(approvalMessage).toMatchObject({ ok: true, messageId: expect.any(String) });
    const approvalPost = (await slackApiCalls()).findLast((call) => (
      call.method === "chat.postMessage" && call.body?.text === APPROVAL_PROMPT
    ));
    expect(approvalPost?.body?.blocks).toMatchObject([
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
    const actionBlock = approvalPost?.body?.blocks?.find((block) => block.type === "actions");
    const approveAlwaysValue = actionBlock?.elements?.find(
      (element) => element.action_id === "gsv_hil_approve_always",
    )?.value;
    expect(approveAlwaysValue).toBeTruthy();
    expect(JSON.parse(approveAlwaysValue!)).toEqual({
      v: 1,
      token: "hil[standalone-request-1]",
    });
    const interaction = await fetcherBinding(env.SLACK_SOCKET).fetch(
      "https://socket.test/interaction",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceMessageId: approvalMessage.messageId,
          sourceText: APPROVAL_PROMPT,
          value: approveAlwaysValue,
          actionTs: "1700000200.000100",
        }),
      },
    );
    await expect(interaction.json()).resolves.toEqual({ sent: 1 });
    await vi.waitFor(async () => {
      expect((await socketState()).acknowledgements).toContainEqual({
        envelope_id: "socket-interaction",
      });
      expect(await gatewayCalls()).toContainEqual(expect.objectContaining({
        installation: { installationId: "singleton" },
        args: expect.objectContaining({
          deliveryId: `interaction:${approvalMessage.messageId}:1700000200.000100`,
          message: expect.objectContaining({
            text: "approve always hil[standalone-request-1]",
          }),
        }),
      }));
      expect(await slackApiCalls()).toContainEqual(expect.objectContaining({
        method: "chat.update",
        body: expect.objectContaining({
          channel: "DALICE01",
          ts: approvalMessage.messageId,
          text: expect.stringContaining("Decision submitted: Always approve."),
        }),
      }));
    });

    const outboundFileBytes = new TextEncoder().encode("standalone outbound file");
    await expect(slack.sendMessage({
      deliveryId: "standalone-slack-file-output",
      surface: {
        kind: "channel",
        id: "CGENERAL1",
        threadId: "1700000000.000102",
      },
      actorId: "UALICE01",
      text: "Standalone file",
      media: [{
        type: "document",
        mimeType: "text/plain",
        filename: "standalone-result.txt",
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
        initial_comment: "*From <@UALICE01>'s GSV:*\nStandalone file",
        thread_ts: "1700000000.000102",
      }),
    }));

    const uninstalled = await fetcherBinding(env.SLACK_SOCKET).fetch(
      "https://socket.test/uninstall",
      { method: "POST" },
    );
    await expect(uninstalled.json()).resolves.toEqual({ sent: 1 });
    await vi.waitFor(async () => {
      expect(await slack.getStatus()).toMatchObject({
        connected: false,
        authenticated: false,
      });
      expect((await socketState()).connections).toBe(0);
    });

    await slack.start(
      "xoxb-standalone-test-token",
      "xapp-standalone-test-token",
      "default",
    );
    await expect(slack.getStatus()).resolves.toMatchObject({
      connected: true,
      authenticated: true,
    });
    await slack.stop();
    await vi.waitFor(async () => {
      expect(await slack.getStatus()).toMatchObject({
        connected: false,
        authenticated: false,
      });
      expect((await socketState()).connections).toBe(0);
    });
  });
});
