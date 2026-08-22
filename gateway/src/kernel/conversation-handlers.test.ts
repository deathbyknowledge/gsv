import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage, ConversationSummary } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";

const { getConversationByIdMock, sendFrameToProcessMock, ensurePersonalControllerMock } = vi.hoisted(() => ({
  getConversationByIdMock: vi.fn(),
  sendFrameToProcessMock: vi.fn(),
  ensurePersonalControllerMock: vi.fn(),
}));

vi.mock("../shared/utils", async (importOriginal) => ({
  ...await importOriginal<typeof import("../shared/utils")>(),
  getConversationById: getConversationByIdMock,
  sendFrameToProcess: sendFrameToProcessMock,
}));

vi.mock("./personal-controller", () => ({
  ensurePersonalController: ensurePersonalControllerMock,
}));

import {
  handleConversationHistory,
  handleConversationHome,
  handleConversationMediaRead,
  handleConversationSend,
} from "./conversation-handlers";

const HOME: ConversationSummary = {
  id: "conv:home",
  ownerUid: 1000,
  kind: "home",
  title: "Home",
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
    },
    conversations: {
      ensureHome: vi.fn(() => HOME),
      get: vi.fn((id: string) => id === HOME.id ? HOME : null),
      list: vi.fn(() => [HOME]),
      recordSequence: vi.fn(),
    },
    runRoutes: {
      setConnectionRoute: vi.fn(),
      delete: vi.fn(),
    },
    broadcastToUserUid: vi.fn(),
  } as unknown as KernelContext;
}

function canonicalMessage(input: any): ConversationMessage {
  return {
    id: input.messageId,
    conversationId: HOME.id,
    sequence: 1,
    author: input.author,
    text: input.text,
    ...(input.media ? { media: input.media } : {}),
    origin: input.origin,
    processId: input.processId,
    ...(input.runId ? { runId: input.runId } : {}),
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

  it("resolves and initializes the stable Home conversation", async () => {
    const initialize = vi.fn(async () => undefined);
    getConversationByIdMock.mockReturnValue({ initialize });
    const ctx = context();

    await expect(handleConversationHome(ctx)).resolves.toEqual({ conversation: HOME });

    expect(ensurePersonalControllerMock).toHaveBeenCalledWith(1000, ctx);
    expect(ctx.conversations.ensureHome).toHaveBeenCalledWith(1000, PROCESS.processId);
    expect(initialize).toHaveBeenCalledWith({ ownerUid: 1000, kind: "home" });
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
      conversationId: HOME.id,
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

  it("rejects conversation operations from a Process caller", async () => {
    const ctx = context();
    ctx.processId = PROCESS.processId;

    await expect(handleConversationHome(ctx)).rejects.toThrow(
      "Conversation operations require a direct user client",
    );
    await expect(handleConversationHistory({ conversationId: HOME.id }, ctx)).rejects.toThrow(
      "Conversation operations require a direct user client",
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
      conversationId: HOME.id,
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
            conversationId: HOME.id,
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

    await expect(handleConversationHistory({ conversationId: HOME.id }, ctx)).resolves.toEqual({
      conversation: expect.objectContaining({ id: HOME.id }),
      messages: [message],
      hasMore: false,
    });
    const media = await handleConversationMediaRead({
      conversationId: HOME.id,
      key: "conversations/conv%3Ahome/media/msg%3Aone/0",
    }, ctx);
    expect(media.data).toMatchObject({ ok: true, conversationId: HOME.id, size: 3 });
    expect(media.body.length).toBe(3);

    await expect(handleConversationHistory({ conversationId: HOME.id }, context(2000)))
      .rejects.toThrow(`Conversation not found: ${HOME.id}`);
  });
});
