import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type { ResponseFrame } from "../protocol/frames";
import type { KernelContext } from "./context";

vi.mock("../shared/utils", () => ({
  sendFrameToProcess: vi.fn(),
}));

import { sendFrameToProcess } from "../shared/utils";
import { remoteSocialProcessAuthority } from "./authority";
import { dispatchMindEvent } from "./mind";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000],
  username: "sam",
  home: "/home/sam",
  cwd: "/home/sam",
  workspaceId: null,
};

const sendFrameToProcessMock = vi.mocked(sendFrameToProcess);

describe("dispatchMindEvent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("spawns a deterministic mind process and delivers a mind event", async () => {
    sendFrameToProcessMock
      .mockResolvedValueOnce({
        type: "res",
        id: "setidentity",
        ok: true,
        data: { ok: true },
      } satisfies ResponseFrame)
      .mockResolvedValueOnce({
        type: "res",
        id: "deliver",
        ok: true,
        data: {
          ok: true,
          status: "started",
          pid: "mind:1000:test",
          conversationId: "mind:social.message:thread-1",
          runId: "run-1",
        },
      } satisfies ResponseFrame);

    const ctx = makeContext(null);
    const result = await dispatchMindEvent(ctx, {
      identity: IDENTITY,
      source: "social.message",
      threadKey: "thread-1",
      title: "Message from Alice",
      text: "Can your GSV look at this?",
      body: { messageId: "msg-1" },
    });

    expect(result).toMatchObject({
      ok: true,
      conversationId: "mind:social.message:thread-1",
      runId: "run-1",
    });
    expect(ctx.procs.ensureInit).toHaveBeenCalledWith(IDENTITY);
    expect(ctx.procs.spawn).toHaveBeenCalledWith(
      expect.stringMatching(/^mind:1000:[a-f0-9]{32}$/),
      IDENTITY,
      expect.objectContaining({
        parentPid: "init:1000",
        profile: "mind",
        label: "Mind: Message from Alice",
      }),
    );
    expect(sendFrameToProcessMock).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^mind:1000:[a-f0-9]{32}$/),
      expect.objectContaining({
        call: "proc.setidentity",
        args: expect.objectContaining({ profile: "mind" }),
      }),
    );
    expect(sendFrameToProcessMock).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^mind:1000:[a-f0-9]{32}$/),
      expect.objectContaining({
        call: "proc.mind.deliver",
        args: expect.objectContaining({
          conversationId: "mind:social.message:thread-1",
          message: expect.stringContaining("Source: social.message"),
        }),
      }),
    );
  });

  it("reuses an existing running mind process", async () => {
    sendFrameToProcessMock.mockResolvedValueOnce({
      type: "res",
      id: "deliver",
      ok: true,
      data: {
        ok: true,
        status: "started",
        pid: "mind:1000:test",
        conversationId: "mind:social.message:thread-1",
        runId: "run-2",
        queued: true,
      },
    } satisfies ResponseFrame);

    const ctx = makeContext({ state: "running" });
    const result = await dispatchMindEvent(ctx, {
      identity: IDENTITY,
      source: "social.message",
      threadKey: "thread-1",
      text: "Second event",
    });

    expect(result).toMatchObject({ ok: true, queued: true });
    expect(ctx.procs.ensureInit).not.toHaveBeenCalled();
    expect(ctx.procs.spawn).not.toHaveBeenCalled();
    expect(sendFrameToProcessMock).toHaveBeenCalledTimes(1);
    expect(sendFrameToProcessMock.mock.calls[0]?.[1]).toMatchObject({
      call: "proc.mind.deliver",
    });
  });

  it("can omit structured data from delivered process events", async () => {
    sendFrameToProcessMock.mockResolvedValueOnce({
      type: "res",
      id: "deliver",
      ok: true,
      data: {
        ok: true,
        status: "started",
        pid: "mind:1000:test",
        conversationId: "mind:social.message:thread-1",
        runId: "run-3",
      },
    } satisfies ResponseFrame);

    const ctx = makeContext({ state: "running" });
    await dispatchMindEvent(ctx, {
      identity: IDENTITY,
      source: "social.message",
      threadKey: "thread-1",
      text: "Visible instructions only.",
      body: { messageId: "msg-1" },
      metadata: { peerHandle: "alice.example" },
      includeStructuredData: false,
    });

    const frame = sendFrameToProcessMock.mock.calls[0]?.[1] as { args?: { message?: string } } | undefined;
    expect(frame?.args?.message).toContain("Visible instructions only.");
    expect(frame?.args?.message).not.toContain("Structured event data");
    expect(frame?.args?.message).not.toContain("msg-1");
    expect(frame?.args?.message).not.toContain("alice.example");
  });

  it("stores remote social authority and isolates it from local mind processes", async () => {
    sendFrameToProcessMock.mockResolvedValue({
      type: "res",
      id: "ok",
      ok: true,
      data: {
        ok: true,
        status: "started",
        pid: "mind:1000:test",
        conversationId: "mind:social.message:thread-1",
        runId: "run-remote",
      },
    } satisfies ResponseFrame);

    const remoteAuthority = remoteSocialProcessAuthority({
      peerHandle: "alice.example",
      peerDid: "did:web:alice.example",
      threadId: "thread-1",
    });
    const remoteCtx = makeContext(null);
    await dispatchMindEvent(remoteCtx, {
      identity: IDENTITY,
      source: "social.message",
      threadKey: "thread-1",
      text: "Remote event",
      authority: remoteAuthority,
    });
    const remotePid = vi.mocked(remoteCtx.procs.spawn).mock.calls[0]?.[0];
    expect(vi.mocked(remoteCtx.procs.spawn).mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      authority: remoteAuthority,
      cwd: "/var/social/alice.example",
    }));

    const localCtx = makeContext(null);
    await dispatchMindEvent(localCtx, {
      identity: IDENTITY,
      source: "social.message",
      threadKey: "thread-1",
      text: "Local event",
    });
    const localPid = vi.mocked(localCtx.procs.spawn).mock.calls[0]?.[0];

    expect(remotePid).toMatch(/^mind:1000:[a-f0-9]{32}$/);
    expect(localPid).toMatch(/^mind:1000:[a-f0-9]{32}$/);
    expect(remotePid).not.toBe(localPid);
  });
});

function makeContext(existing: { state: string } | null): KernelContext {
  return {
    procs: {
      get: vi.fn(() => existing),
      ensureInit: vi.fn(() => ({ pid: "init:1000", created: false })),
      spawn: vi.fn(),
    },
  } as unknown as KernelContext;
}
