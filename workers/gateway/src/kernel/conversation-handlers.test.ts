import { beforeEach, describe, expect, it, vi } from "vitest";
import { testPeer } from "../test-support/peers";
import {
  REQUEST_CANCEL_SIGNAL,
  type ConversationMessage,
  type ConversationSummary,
  type ResourceBlock,
} from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { ShipReplies } from "./ship-replies";
import { RunRouteStore } from "./run-routes";

import * as utils from "../shared/utils";
import * as personalController from "./personal-controller";
import * as targets from "./targets";
const getConversationByIdMock = vi.spyOn(utils, "getConversationById");
const sendFrameToProcessMock = vi.spyOn(utils, "sendFrameToProcess");
const ensurePersonalControllerMock = vi.spyOn(personalController, "ensurePersonalController");

import {
  handleConversationHistory,
  handleConversationSearch,
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
    installationId: "inst_test",
    peer: testPeer({ kind: "human", account: {
        uid: ownerUid,
        gid: ownerUid,
        gids: [ownerUid],
        username: `user-${ownerUid}`,
        home: `/home/user-${ownerUid}`,
        cwd: `/home/user-${ownerUid}`,
      }, calls: ["conversation.*"] }),
    connection: {
      id: "connection-1",
      state: { clientId: "desktop-1", clientPlatform: "macos" },
    },
    procs: {
      get: vi.fn((pid: string) => pid === PROCESS.processId ? PROCESS : null),
      getOwnerUid: vi.fn((pid: string) => pid === PROCESS.processId ? PROCESS.ownerUid : null),
    },
    conversations: {
      getShip: vi.fn(() => SHIP),
      ensureShip: vi.fn(() => SHIP),
      get: vi.fn((id: string) => id === SHIP.id ? SHIP : null),
      list: vi.fn(() => [SHIP]),
      recordSequence: vi.fn(),
      recordContactMessage: vi.fn(),
    },
    shipReplies: { recordClientInput: vi.fn() },
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
    ...(input.selectedTarget ? { selectedTarget: input.selectedTarget } : undefined),
    ...(input.media ? { media: input.media } : undefined),
    origin: input.origin,
    processId: input.processId,
    ...(input.runId ? { runId: input.runId } : undefined),
    createdAt: input.createdAt,
  };
}

describe("conversation handlers", () => {
  it("does not turn a message to a contact into input for Ship, including a legacy handler record", async () => {
    const ctx = context();
    vi.mocked(ctx.conversations.get).mockReturnValue({ ...SHIP, kind: "contact" });
    await expect(handleConversationSend({ conversationId: SHIP.id, text: "Hello Alice" }, ctx))
      .rejects.toThrow("Use contact.send");
    expect(sendFrameToProcessMock).not.toHaveBeenCalled();
  });

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
      selectedTarget: "gsv",
      idempotencyKey: "desktop:one",
    }, ctx)).rejects.toThrow("Process unavailable");

    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0][0]).toMatchObject({ text: "remember this", selectedTarget: "gsv" });
    expect(sendFrameToProcessMock.mock.calls[0][2]).toMatchObject({ call: "proc.send", args: { message: "remember this", selectedTarget: "gsv" } });
    expect(append.mock.invocationCallOrder[0]).toBeLessThan(
      sendFrameToProcessMock.mock.invocationCallOrder[0],
    );
    expect(ctx.broadcastToUserUid).toHaveBeenCalledWith(1000, "message.committed", {
      message: expect.objectContaining({ text: "remember this" }),
      directed: false,
    });
    expect(ctx.runRoutes.delete).toHaveBeenCalledWith(expect.stringMatching(/^run:msg:/));
  });

  it.each([false, true])("keeps a replayed input preference without replacing newer activity=%s", async (newerActivity) => {
    await runWithRealKernelSql(async (sql, storage) => {
      const ctx = context();
      ctx.shipReplies = new ShipReplies(storage);
      ctx.runRoutes = new RunRouteStore(sql);
      ctx.shipReplies.recordAdapter(1000);
      let message: ConversationMessage | undefined;
      const append = vi.fn(async (input: any) => {
        if (message) return { created: false, message };
        message = canonicalMessage(input);
        throw new Error("lost append response after commit");
      });
      getConversationByIdMock.mockReturnValue({ append });
      sendFrameToProcessMock.mockImplementation(async (_installationId, _pid, frame) => ({
        type: "res", id: frame.id, ok: true,
        data: { ok: true, runId: message!.runId, queued: false, status: "started" },
      }));
      const input = { conversationId: SHIP.id, text: "Reply here", idempotencyKey: "same-input" };
      await expect(handleConversationSend(input, ctx)).rejects.toThrow("lost append response");
      ctx.shipReplies = new ShipReplies(storage);
      ctx.runRoutes = new RunRouteStore(sql);
      if (newerActivity) ctx.shipReplies.recordClient(1000, "newer-window");
      await expect(handleConversationSend(input, ctx)).resolves.toMatchObject({ runId: message!.runId });
      expect(storage.kv.get<{ connectionId: string }>("ship-reply:1000")?.connectionId)
        .toBe(newerActivity ? "newer-window" : "connection-1");
    });
  });

  it.each([[false, false], [true, false], [false, true]])("selects the newer overlapping send, newer first=%s, concurrent retry=%s", async (newerFirst, retryWhilePreparing) => {
    await runWithRealKernelSql(async (sql, storage) => {
      const first = context();
      const second = context();
      second.connection!.id = "connection-2";
      first.shipReplies = second.shipReplies = new ShipReplies(storage);
      first.runRoutes = second.runRoutes = new RunRouteStore(sql);
      const release = new Map<string, () => void>();
      const target = vi.spyOn(targets, "resolveSelectedMessageTarget").mockImplementation(
        (ctx) => new Promise((resolve) => release.set(ctx.connection!.id, () => resolve("gsv"))),
      );
      getConversationByIdMock.mockReturnValue({
        append: vi.fn(async (input: any) => ({ created: true, message: canonicalMessage(input) })),
      });
      sendFrameToProcessMock.mockImplementation(async (_installationId, _pid, frame) => ({
        type: "res", id: frame.id, ok: true,
        data: { ok: true, runId: `run:${frame.args.interaction.messageId}`, queued: false, status: "started" },
      }));
      try {
        const inputs = [0, 1].map((i) => ({ conversationId: SHIP.id, text: `Message ${i}`, idempotencyKey: `overlap-${i}` }));
        const pending = [first, second].map((ctx, i) => handleConversationSend(inputs[i], ctx));
        await vi.waitFor(() => expect(release.size).toBe(2));
        if (retryWhilePreparing) {
          const original = release.get("connection-1")!;
          release.get("connection-2")!();
          await pending[1];
          const retry = handleConversationSend(inputs[0], first);
          await vi.waitFor(() => expect(release.get("connection-1")).not.toBe(original));
          release.get("connection-1")!();
          await retry;
          original();
          await pending[0];
        } else {
          for (const index of newerFirst ? [1, 0] : [0, 1]) {
            release.get(`connection-${index + 1}`)!();
            await pending[index];
          }
        }
        expect(storage.kv.get<{ connectionId: string }>("ship-reply:1000")?.connectionId).toBe("connection-2");
      } finally {
        target.mockRestore();
      }
    });
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

  it("searches only owned conversations for signed-in people and their canonical Ship", async () => {
    const search = vi.fn(async () => ({ hits: [], nextBeforeSequence: null }));
    getConversationByIdMock.mockReturnValue({ search });
    const ctx = context();
    await expect(handleConversationSearch({ query: "Rotterdam", limit: 10 }, ctx)).resolves.toMatchObject({ conversation: SHIP, hits: [] });
    expect(search).toHaveBeenCalledWith({ query: "Rotterdam", limit: 10, beforeSequence: undefined });
    expect(getConversationByIdMock).toHaveBeenCalledWith("inst_test", SHIP.id);
    ctx.processId = PROCESS.processId;
    await expect(handleConversationSearch({ query: "Rotterdam" }, ctx)).resolves.toMatchObject({ hits: [] });
    ctx.procs.get = vi.fn(() => ({ ...PROCESS, isPersonalController: false }));
    await expect(handleConversationSearch({ query: "Rotterdam" }, ctx)).rejects.toThrow("signed-in human or their Ship");
    await expect(handleConversationSearch({ conversationId: SHIP.id, query: "Rotterdam" }, context(1002))).rejects.toThrow("Conversation not found");
    expect(search).toHaveBeenCalledTimes(2);
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
      "inst_test",
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
      followsShip: true,
      runId: result.runId,
      processId: PROCESS.processId,
      uid: 1000,
      connectionId: "connection-1",
      clientPlatform: "macos",
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
      "inst_test",
      PROCESS.processId,
      expect.objectContaining({ call: "proc.resources.retain" }),
    ));
    const retainFrame = sendFrameToProcessMock.mock.calls.find(
      ([, , frame]) => frame.type === "req" && frame.call === "proc.resources.retain",
    )?.[2];
    if (!retainFrame || retainFrame.type !== "req") {
      throw new Error("Resource retain request was not captured");
    }

    controller.abort(new Error("Upload cancelled"));

    await expect(retaining).rejects.toThrow("Upload cancelled");
    expect(sendFrameToProcessMock).toHaveBeenCalledWith(
      "inst_test",
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
