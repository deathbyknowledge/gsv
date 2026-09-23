import { beforeEach, describe, expect, it, vi } from "vitest";
import { REQUEST_CANCEL_SIGNAL } from "@humansandmachines/gsv/protocol";
import type { sendFrameToProcess } from "../shared/utils";
import { authorizeNestedOperation, nestedToolOwner } from "./tool-approval";
import type { KernelContext } from "./context";

const send = vi.fn<typeof sendFrameToProcess>();

function context(signal?: AbortSignal): KernelContext {
  // SAFETY: this test exercises only the request ownership fields of KernelContext.
  return {
    installationId: "installation", processId: "process", processRunId: "run", requestId: "outer",
    toolOwner: { runId: "run", requestId: "outer" }, requestSignal: signal, defer: vi.fn(),
  } as KernelContext;
}

describe("Kernel nested approval ownership", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retains the root request across additional native commands", () => {
    const ctx = context();
    ctx.requestId = "inner";
    expect(nestedToolOwner(ctx)).toEqual({ runId: "run", requestId: "outer" });
  });

  it("leaves direct human work and already-approved direct tool dispatch alone", async () => {
    const ctx = context();
    delete ctx.toolOwner;
    await authorizeNestedOperation(ctx, "mail.send", {}, undefined, send);
    expect(send).not.toHaveBeenCalled();
  });

  it("fails closed when the owning Process denies the actual destination", async () => {
    send.mockResolvedValue({ type: "res", id: "reply", ok: true, data: { approved: false } });
    await expect(authorizeNestedOperation(context(), "fs.transfer.receive", { target: "laptop", path: "/tmp/a" }, undefined, send)).rejects.toThrow("not approved");
    expect(send).toHaveBeenCalledWith("installation", "process", expect.objectContaining({
      call: "proc.tool.authorize", args: expect.objectContaining({ runId: "run", requestId: "outer", syscall: "fs.transfer.receive", args: { target: "laptop", path: "/tmp/a" } }),
    }));
  });

  it("settles cancellation even when the Process cancellation RPC never returns", async () => {
    send.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const waiting = authorizeNestedOperation(context(controller.signal), "sys.mcp.call", {}, undefined, send);
    const rejected = expect(waiting).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await rejected;
    expect(send).toHaveBeenLastCalledWith("installation", "process", expect.objectContaining({
      type: "sig", signal: REQUEST_CANCEL_SIGNAL, payload: expect.objectContaining({ id: expect.stringMatching(/^approval:/) }),
    }));
  });
});
