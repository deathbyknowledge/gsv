import { beforeEach, describe, expect, it, vi } from "vitest";
import * as processTransport from "../shared/utils";
import { authorizeNestedOperation, nestedToolOwner } from "./tool-approval";
import type { KernelContext } from "./context";

function context(signal?: AbortSignal): KernelContext {
  // SAFETY: this test exercises only the request ownership fields of KernelContext.
  return {
    installationId: "installation", processId: "process", processRunId: "run", requestId: "outer",
    toolOwner: { runId: "run", requestId: "outer" }, requestSignal: signal, defer: vi.fn(),
  } as KernelContext;
}

describe("Kernel nested approval ownership", () => {
  let authorize: ReturnType<typeof vi.spyOn<typeof processTransport, "authorizeProcessTool">>;
  beforeEach(() => {
    vi.restoreAllMocks();
    authorize = vi.spyOn(processTransport, "authorizeProcessTool");
  });

  it("retains the root request across additional native commands", () => {
    const ctx = context();
    ctx.requestId = "inner";
    expect(nestedToolOwner(ctx)).toEqual({ runId: "run", requestId: "outer" });
  });

  it("leaves direct human work and already-approved direct tool dispatch alone", async () => {
    const ctx = context();
    delete ctx.toolOwner;
    await authorizeNestedOperation(ctx, "mail.send", {});
    expect(authorize).not.toHaveBeenCalled();
  });

  it("fails closed when the owning Process denies the actual destination", async () => {
    authorize.mockResolvedValue({ approved: false });
    await expect(authorizeNestedOperation(context(), "fs.transfer.receive", { target: "laptop", path: "/tmp/a" })).rejects.toThrow("not approved");
    expect(authorize).toHaveBeenCalledWith("installation", "process", expect.stringMatching(/^approval:/), expect.objectContaining({
      runId: "run", requestId: "outer", syscall: "fs.transfer.receive", args: { target: "laptop", path: "/tmp/a" },
    }));
  });

  it("fails closed when the owning Process is gone", async () => {
    authorize.mockResolvedValue({ unavailable: "killed", message: "Process no longer exists" });
    await expect(authorizeNestedOperation(context(), "mail.send", {})).rejects.toThrow("Process no longer exists");
  });

  it("settles cancellation even when the Process cancellation RPC never returns", async () => {
    authorize.mockImplementation(() => new Promise(() => {}));
    const cancel = vi.spyOn(processTransport, "cancelProcessCall").mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const waiting = authorizeNestedOperation(context(controller.signal), "sys.mcp.call", {});
    const rejected = expect(waiting).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    await rejected;
    const cancelId = authorize.mock.lastCall?.[2];
    expect(cancelId).toMatch(/^approval:/);
    expect(cancel).toHaveBeenLastCalledWith("installation", "process", cancelId, "Owning operation was cancelled");
  });
});
