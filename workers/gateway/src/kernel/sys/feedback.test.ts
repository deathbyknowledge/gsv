import { afterEach, describe, expect, it, vi } from "vitest";
import * as transport from "../../shared/utils";
import { testPeer } from "../../test-support/peers";
import type { KernelContext } from "../context";
import { bodyFromText, type BinaryBody } from "@humansandmachines/gsv/protocol";
import { FEEDBACK_MAX_BODY_BYTES, type FeedbackReport } from "@humansandmachines/gsv/services/feedback";
import { handleSysFeedback as handle } from "./feedback";

function handleSysFeedback(report: FeedbackReport, ctx: KernelContext) {
  const { id, context, ...content } = report;
  return handle({ ...(id !== undefined ? { id } : {}), ...(context ? { context } : {}) }, ctx, bodyFromText(JSON.stringify(content)));
}

function fixture() {
  const submitFeedback = vi.fn(async ({ id }: { id: string }) => ({ id }));
  // SAFETY: the handler reads only the caller, installation and service fields supplied here.
  const ctx = {
    installationId: "inst_feedback",
    installationIdentity: { canonicalOrigin: "https://example.gsv.space" },
    serverVersion: "0.6.2",
    peer: testPeer({ account: { uid: 1000, gid: 100, gids: [100], username: "person", home: "/home/person", cwd: "/home/person" } }),
    procs: { getOwnerUid: () => 1000 },
    env: { FEEDBACK: { submitFeedback } },
  } as KernelContext;
  return { ctx, submitFeedback };
}

describe("operator feedback", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("rejects a missing body and cancels bodies rejected before reading", async () => {
    const { ctx, submitFeedback } = fixture();
    await expect(handle({}, ctx)).rejects.toThrow("report body");
    const cancel = vi.fn();
    delete ctx.env.FEEDBACK;
    await expect(handle({}, ctx, { stream: new ReadableStream({ cancel }) })).rejects.toThrow("not available");
    expect(cancel).toHaveBeenCalledOnce();
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it.each([true, false])("cancels an oversized body (declared length: %s)", async (declared) => {
    const { ctx, submitFeedback } = fixture();
    const cancel = vi.fn();
    const body: BinaryBody = { stream: new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(FEEDBACK_MAX_BODY_BYTES + 1)); }, cancel,
    }), ...(declared ? { length: FEEDBACK_MAX_BODY_BYTES + 1 } : {}) };
    await expect(handle({}, ctx, body)).rejects.toThrow("Body exceeds limit");
    expect(cancel).toHaveBeenCalledOnce();
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it("ends a stalled upload at the delivery deadline and releases its reader", async () => {
    vi.useFakeTimers();
    const { ctx, submitFeedback } = fixture();
    const cancel = vi.fn();
    const body = { stream: new ReadableStream<Uint8Array>({ cancel }) };
    const rejected = expect(handle({}, ctx, body)).rejects.toThrow("Feedback delivery timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.stream.locked).toBe(false);
    expect(submitFeedback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not expose malformed JSON content in errors", async () => {
    const { ctx, submitFeedback } = fixture();
    await expect(handle({}, ctx, bodyFromText("private invalid report"))).rejects.toThrow(/^Invalid feedback report$/);
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it("bounds a stalled inbox, disposes the remote call and allows a retry", async () => {
    vi.useFakeTimers();
    const { ctx, submitFeedback } = fixture();
    const dispose = vi.fn();
    const stalled = Object.assign(new Promise<{ id: string }>(() => {}), { [Symbol.dispose]: dispose });
    submitFeedback.mockReturnValueOnce(stalled);
    const input = { id: crypto.randomUUID(), message: "Report" };
    const rejected = expect(handleSysFeedback(input, ctx)).rejects.toThrow("Feedback delivery timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(dispose).toHaveBeenCalledOnce();
    expect(await handleSysFeedback(input, ctx)).toEqual({ id: input.id });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an in-flight RPC on caller abort and ignores a late receipt", async () => {
    vi.useFakeTimers();
    const { ctx, submitFeedback } = fixture();
    const controller = new AbortController();
    ctx.requestSignal = controller.signal;
    let resolve!: (result: { id: string }) => void;
    const dispose = vi.fn();
    submitFeedback.mockReturnValueOnce(Object.assign(new Promise<{ id: string }>(done => { resolve = done; }), { [Symbol.dispose]: dispose }));
    const rejected = expect(handleSysFeedback({ message: "Report" }, ctx)).rejects.toThrow("Caller cancelled");
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("Caller cancelled"));
    await rejected;
    resolve({ id: "late" });
    expect(dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for the owning Process and does not deliver a denied report", async () => {
    const { ctx, submitFeedback } = fixture();
    ctx.processId = "proc:ship";
    ctx.toolOwner = { runId: "run", requestId: "shell" };
    let approve!: (approved: boolean) => void;
    const send = vi.spyOn(transport, "sendFrameToProcess").mockImplementation(async () => ({
      type: "res", id: "approval", ok: true, data: { approved: await new Promise<boolean>(resolve => { approve = resolve; }) },
    }));
    const pending = handleSysFeedback({ message: "Report" }, ctx);
    const rejected = expect(pending).rejects.toThrow("not approved");
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith("inst_feedback", "proc:ship", expect.objectContaining({
      call: "proc.tool.authorize", args: expect.objectContaining({ syscall: "sys.feedback", args: {} }),
    }));
    expect(submitFeedback).not.toHaveBeenCalled();
    approve(false);
    await rejected;
    expect(submitFeedback).not.toHaveBeenCalled();
  });
  it("attaches trusted space and owner identity to a bounded report", async () => {
    const { ctx, submitFeedback } = fixture();
    const id = crypto.randomUUID();
    expect(await handleSysFeedback({ id, message: "  The attachment will not open.  ", context: { platform: "desktop", view: "zen" } }, ctx)).toEqual({ id });
    expect(submitFeedback).toHaveBeenCalledWith({ id, message: "The attachment will not open.",
      context: { platform: "desktop", view: "zen" }, installationId: "inst_feedback",
      space: "https://example.gsv.space", ownerUid: 1000, source: "client", serverVersion: "0.6.2" });
  });

  it("attributes an agent report to its human owner", async () => {
    const { ctx, submitFeedback } = fixture();
    ctx.processId = "proc:ship";
    ctx.peer!.peer.principal.account.uid = 1001;
    const result = await handleSysFeedback({ message: "Please fix the download." }, ctx);
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(submitFeedback).toHaveBeenCalledWith(expect.objectContaining({ ownerUid: 1000, source: "agent" }));
  });

  it("forwards only explicitly supplied activity within the report bounds", async () => {
    const { ctx, submitFeedback } = fixture();
    const activity = { pid: "proc:ship", messageCount: 2, text: "user: help\nShip: inspecting", truncated: false };
    await handleSysFeedback({ message: "A report", activity }, ctx);
    expect(submitFeedback).toHaveBeenCalledWith(expect.objectContaining({ activity }));
    await expect(handleSysFeedback({ message: "A report", activity: { ...activity, text: "x".repeat(64_001) } }, ctx)).rejects.toThrow("Invalid feedback report");
    await expect(handleSysFeedback({ message: "A report", activity: { ...activity, messageCount: 21 } }, ctx)).rejects.toThrow("Invalid feedback report");
    expect(submitFeedback).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, {}, { id: "wrong-report" }, { id: 17 }, "invalid"])("rejects an invalid inbox receipt and permits a retry: %j", async (receipt) => {
    const { ctx, submitFeedback } = fixture();
    // SAFETY: intentionally malformed RPC results exercise the service trust boundary.
    submitFeedback.mockResolvedValueOnce(receipt as { id: string });
    const input = { id: crypto.randomUUID(), message: "Report" };
    await expect(handleSysFeedback(input, ctx)).rejects.toThrow("Invalid feedback receipt");
    expect(await handleSysFeedback(input, ctx)).toEqual({ id: input.id });
  });

  it.each([
    { message: " " }, { message: "x".repeat(8001) }, { message: "ok", id: "invalid" },
    { message: "ok", installationId: "other" }, { message: "ok", ownerUid: 0 },
    { message: "ok", context: { conversation: "private content" } },
  ])("rejects invalid or unapproved fields before delivery", async (args) => {
    const { ctx, submitFeedback } = fixture();
    await expect(handleSysFeedback(args, ctx)).rejects.toThrow("Invalid feedback report");
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it("does not deliver unavailable or already-cancelled requests", async () => {
    const { ctx, submitFeedback } = fixture();
    ctx.requestSignal = AbortSignal.abort();
    await expect(handleSysFeedback({ message: "A report" }, ctx)).rejects.toThrow();
    expect(submitFeedback).not.toHaveBeenCalled();
    delete ctx.env.FEEDBACK;
    await expect(handleSysFeedback({ message: "A report" }, ctx)).rejects.toThrow("not available");
  });
});
