import { afterEach, describe, expect, it, vi } from "vitest";
import * as transport from "../../shared/utils";
import { testPeer } from "../../test-support/peers";
import type { KernelContext } from "../context";
import { handleSysFeedback } from "./feedback";

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
  afterEach(() => vi.restoreAllMocks());

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
      call: "proc.tool.authorize", args: expect.objectContaining({ syscall: "sys.feedback", args: { message: "Report" } }),
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
