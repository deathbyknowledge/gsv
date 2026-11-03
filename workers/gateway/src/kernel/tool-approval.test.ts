import { beforeEach, describe, expect, it, vi } from "vitest";
import { REQUEST_CANCEL_SIGNAL } from "@humansandmachines/gsv/protocol";
import * as processTransport from "../shared/utils";
import { authorizeNestedOperation, nestedToolOwner } from "./tool-approval";
import type { KernelContext } from "./context";

const authorize = vi.fn<typeof processTransport.authorizeProcessTool>();

function context(signal?: AbortSignal): KernelContext {
  // SAFETY: this test exercises only the request ownership fields of KernelContext.
  return {
    installationId: "installation", processId: "process", processRunId: "run", requestId: "outer",
    toolOwner: { runId: "run", requestId: "outer" }, requestSignal: signal, defer: vi.fn(),
  } as KernelContext;
}

describe("Kernel nested approval ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("retains the root request across additional native commands", () => {
    const ctx = context();
    ctx.requestId = "inner";
    expect(nestedToolOwner(ctx)).toEqual({ runId: "run", requestId: "outer" });
  });

  it("leaves direct human work and already-approved direct tool dispatch alone", async () => {
    const ctx = context();
    delete ctx.toolOwner;
    await authorizeNestedOperation(ctx, "mail.send", {}, authorize);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("fails closed when the owning Process denies the actual destination", async () => {
    authorize.mockResolvedValue({ approved: false });
    await expect(authorizeNestedOperation(context(), "fs.transfer.receive", { target: "laptop", path: "/tmp/a" }, authorize)).rejects.toThrow("not approved");
    expect(authorize).toHaveBeenCalledWith("installation", "process", expect.stringMatching(/^approval:/), expect.objectContaining({
      runId: "run", requestId: "outer", syscall: "fs.transfer.receive", args: { target: "laptop", path: "/tmp/a" },
    }));
  });

  it("fails closed when the owning Process is gone", async () => {
    authorize.mockResolvedValue({ unavailable: "killed", message: "Process no longer exists" });
    await expect(authorizeNestedOperation(context(), "mail.send", {}, authorize)).rejects.toThrow("Process no longer exists");
  });

  it("settles cancellation even when the Process cancellation RPC never returns", async () => {
    authorize.mockImplementation(() => new Promise(() => {}));
    const cancel = vi.spyOn(processTransport, "sendFrameToProcess").mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const waiting = authorizeNestedOperation(context(controller.signal), "sys.mcp.call", {}, authorize);
    const rejected = expect(waiting).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await rejected;
    const requestId = authorize.mock.lastCall?.[2];
    expect(requestId).toMatch(/^approval:/);
    expect(cancel).toHaveBeenLastCalledWith("installation", "process", {
      type: "sig", signal: REQUEST_CANCEL_SIGNAL, payload: { id: requestId, reason: "Owning operation was cancelled" },
    });
  });
});
