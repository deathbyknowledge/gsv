import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REQUEST_CANCEL_SIGNAL,
  type ConversationMessage,
  type ConversationSummary,
  type ResourceBlock,
} from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";

import * as utils from "../shared/utils";
import * as personalController from "./personal-controller";
const getConversationByIdMock = vi.spyOn(utils, "getConversationById");
const sendFrameToProcessMock = vi.spyOn(utils, "sendFrameToProcess");
const ensurePersonalControllerMock = vi.spyOn(personalController, "ensurePersonalController");

import {
  handleConversationHistory,
  handleConversationShip,
  handleConversationMediaRead,
  handleConversationSend,
  retainConversationResources,
} from "./conversation-handlers";

const SHIP: ConversationSummary = {
  id: "conv:ship",
  ownerUid: 1000,
  kind: "ship",
  title: "Ship",
  handlerPid: "proc:personal",
  latestSequence: 0,
  createdAt: 1,
  updatedAt: 1,
};

const PROCESS = {
  processId: "proc:personal",
  ownerUid: 1000,
  uid: 1001,
  gid: 1001,
  home: "/home/personal",
  interactive: true,
  isPersonalController: true,
  label: "Personal",
};

function context(ownerUid = 1000): KernelContext {
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  return {
    installationId: "singleton",
    identity: {
      role: "user",
      process: {
        uid: ownerUid,
        gid: ownerUid,
        gids: [ownerUid],
        username: `user-${ownerUid}`,
        home: `/home/user-${ownerUid}`,
        cwd: `/home/user-${ownerUid}`,
      },
      capabilities: ["conversation.*"],
    },
    connection: {
      id: "connection-1",
      state: { clientId: "desktop-1", clientPlatform: "macos" },
    },
    procs: {
      get: vi.fn((pid: string) => pid === PROCESS.processId ? PROCESS : null),
      getOwnerUid: vi.fn((pid: string) => pid === PROCESS.processId ? PROCESS.ownerUid : null),
    },
    conversations: {
      ensureShip: vi.fn(() => SHIP),
      get: vi.fn((id: string) => id === SHIP.id ? SHIP : null),
      list: vi.fn(() => [SHIP]),
      recordSequence: vi.fn(),
    },
    runRoutes: {
      setConnectionRoute: vi.fn(),
      delete: vi.fn(),
    },
    broadcastToUserUid: vi.fn(),
  // SAFETY: test fixture is constructed with the asserted kernel domain shape.
  } as KernelContext;
}

function canonicalMessage(input: any): ConversationMessage {
  return {
    id: input.messageId,
    conversationId: SHIP.id,
    sequence: 1,
    author: input.author,
    text: input.text,
    ...(input.media ? { media: input.media } : undefined),
    origin: input.origin,
    processId: input.processId,
    ...(input.runId ? { runId: input.runId } : undefined),
    createdAt: input.createdAt,
  };
}

describe("conversation handlers", () => {
  beforeEach(() => {
    getConversationByIdMock.mockReset();
    sendFrameToProcessMock.mockReset();
    ensurePersonalControllerMock.mockReset();
    ensurePersonalControllerMock.mockResolvedValue(PROCESS.processId);
  });

  it("resolves and initializes the stable Ship conversation", async () => {
    const initialize = vi.fn(async () => undefined);
    getConversationByIdMock.mockReturnValue({ initialize });
    const ctx = context();

    await expect(handleConversationShip(ctx)).resolves.toEqual({ conversation: SHIP });

    expect(ensurePersonalControllerMock).toHaveBeenCalledWith(1000, ctx);
    expect(ctx.conversations.ensureShip).toHaveBeenCalledWith(1000, PROCESS.processId);
    expect(initialize).toHaveBeenCalledWith({ ownerUid: 1000, kind: "ship" });
  });

  it("keeps an accepted user message when its Process admission fails", async () => {
    const append = vi.fn(async (input: any) => ({
      created: true,
      message: canonicalMessage(input),
    }));
    getConversationByIdMock.mockReturnValue({ append });
    sendFrameToProcessMock.mockImplementation(async (_installationId, _pid, frame) => ({
      type: "res",
      id: frame.id,
      ok: false,
      error: { code: 500, message: "Process unavailable" },
    }));
    const ctx = context();

    await expect(handleConversationSend({
      conversationId: SHIP.id,
      text: "remember this",
      idempotencyKey: "desktop:one",
    }, ctx)).rejects.toThrow("Process unavailable");

    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.invocationCallOrder[0]).toBeLessThan(
      sendFrameToProcessMock.mock.invocationCallOrder[0],
    );
    expect(ctx.broadcastToUserUid).toHaveBeenCalledWith(1000, "message.committed", {
      message: expect.objectContaining({ text: "remember this" }),
      directed: false,
    });
    expect(ctx.runRoutes.delete).toHaveBeenCalledWith(expect.stringMatching(/^run:msg:/));
  });

  it("lets the canonical Ship read history but keeps client mutations direct", async () => {
    const ctx = context();
    ctx.processId = PROCESS.processId;
    getConversationByIdMock.mockReturnValue({
      history: vi.fn(async () => ({ messages: [], hasMore: false, latestSequence: 0 })),
    });

    await expect(handleConversationShip(ctx)).rejects.toThrow(
      "Conversation operations require a direct user client",
    );
    await expect(handleConversationHistory({ conversationId: SHIP.id }, ctx)).resolves.toEqual({
      conversation: SHIP,
      messages: [],
      hasMore: false,
    });

    ctx.procs.get = vi.fn(() => ({ ...PROCESS, isPersonalController: false }));
    await expect(handleConversationHistory({ conversationId: SHIP.id }, ctx)).rejects.toThrow(
      "Conversation history requires a signed-in human or their Ship",
    );
  });

  it("admits the canonical input into the handler and pins the reply to its client", async () => {
    const append = vi.fn(async (input: any) => ({
      created: true,
      message: canonicalMessage(input),
    }));
    getConversationByIdMock.mockReturnValue({ append });
    sendFrameToProcessMock.mockImplementation(async (_installationId, _pid, frame) => ({
      type: "res",
      id: frame.id,
      ok: true,
      data: { ok: true, status: "started", runId: `run:${frame.args.interaction.messageId}` },
    }));
    const ctx = context();

    const result = await handleConversationSend({
      conversationId: SHIP.id,
      text: "hello",
      idempotencyKey: "desktop:two",
    }, ctx);

    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      "singleton",
      PROCESS.processId,
      expect.objectContaining({
        call: "proc.send",
        args: expect.objectContaining({
          message: "hello",
          interaction: {
            conversationId: SHIP.id,
            messageId: result.message.id,
          },
        }),
      }),
    );
    expect(ctx.runRoutes.setConnectionRoute).toHaveBeenCalledWith({
      runId: result.runId,
      processId: PROCESS.processId,
      uid: 1000,
      connectionId: "connection-1",
    });
    expect(vi.mocked(ctx.runRoutes.setConnectionRoute).mock.invocationCallOrder[0])
      .toBeLessThan(sendFrameToProcessMock.mock.invocationCallOrder[0]);
  });

  it("forwards client cancellation to in-flight resource retention", async () => {
    const controller = new AbortController();
    const ctx = context();
    ctx.requestSignal = controller.signal;
    const resource: ResourceBlock = {
      type: "resource",
      ref: {
        type: "file",
        target: "gsv",
        path: "/home/hank/archive/image.png",
        revision: "revision:image",
        contentType: "image/png",
        size: 3,
      },
    };
    sendFrameToProcessMock.mockImplementation(async (_installationId, _pid, frame) => {
      if (frame.type === "sig") return null;
      return await new Promise<never>(() => {});
    });

    const retaining = retainConversationResources([resource], PROCESS.processId, ctx);
    await vi.waitFor(() => expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      "singleton",
      PROCESS.processId,
      expect.objectContaining({ call: "proc.resource.retain" }),
    ));
    const retainFrame = sendFrameToProcessMock.mock.calls.find(
      ([, , frame]) => frame.type === "req" && frame.call === "proc.resource.retain",
    )?.[2];
    if (!retainFrame || retainFrame.type !== "req") {
      throw new Error("Resource retain request was not captured");
    }

    controller.abort(new Error("Upload cancelled"));

    await expect(retaining).rejects.toThrow("Upload cancelled");
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      "singleton",
      PROCESS.processId,
      {
        type: "sig",
        signal: REQUEST_CANCEL_SIGNAL,
        payload: { id: retainFrame.id, reason: "Upload cancelled" },
      },
    );
  });

  it("reads canonical history and media only through an owned conversation", async () => {
    const message = canonicalMessage({
      messageId: "msg:one",
      author: { kind: "user", uid: 1000 },
      text: "hello",
      origin: { kind: "client" },
      processId: PROCESS.processId,
      createdAt: 1,
    });
    const history = vi.fn(async () => ({
      messages: [message],
      hasMore: false,
      latestSequence: 1,
    }));
    const readMedia = vi.fn(async () => ({
      key: "conversations/conv%3Ahome/media/msg%3Aone/0",
      mimeType: "image/png",
      size: 3,
      stream: new ReadableStream<Uint8Array>(),
    }));
    getConversationByIdMock.mockReturnValue({ history, readMedia });
    const ctx = context();

    await expect(handleConversationHistory({ conversationId: SHIP.id }, ctx)).resolves.toEqual({
      conversation: expect.objectContaining({ id: SHIP.id }),
      messages: [message],
      hasMore: false,
    });
    const media = await handleConversationMediaRead({
      conversationId: SHIP.id,
      key: "conversations/conv%3Ahome/media/msg%3Aone/0",
    }, ctx);
    expect(media.data).toMatchObject({ ok: true, conversationId: SHIP.id, size: 3 });
    expect(media.body.length).toBe(3);

    await expect(handleConversationHistory({ conversationId: SHIP.id }, context(2000)))
      .rejects.toThrow(`Conversation not found: ${SHIP.id}`);
  });
});
