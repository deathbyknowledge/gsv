import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch, type DispatchDeps } from "./dispatch";
import type { KernelContext } from "./context";
import type { RequestFrame } from "../protocol/frames";
import * as federation from "./federation";
import * as nativeTarget from "../drivers/native/target";
import * as processTransport from "../shared/utils";

const source = { target: "contact:alice", path: "/resources/shared" };
const owner = { runId: "run", requestId: "shell" };
// SAFETY: these local dispatch paths do not call external target routing.
const deps = {} as DispatchDeps;

function context(signal?: AbortSignal): KernelContext {
  // SAFETY: federation I/O is mocked; only these dispatch/approval fields are used.
  return { installationId: "installation", processId: "process", processRunId: "run",
    toolOwner: owner, requestSignal: signal, defer: vi.fn() } as KernelContext;
}

afterEach(() => vi.restoreAllMocks());

describe("nested contact resource approvals", () => {
  it.each(["fs.read", "fs.transfer.send"] as const)("denies %s before opening a contact resource", async (call) => {
    const send = vi.spyOn(processTransport, "sendFrameToProcess")
      .mockResolvedValue({ type: "res", id: "approval", ok: true, data: { approved: false } });
    const read = vi.spyOn(federation, "handleContactResourceRead");
    const transfer = vi.spyOn(federation, "handleContactResourceSend");
    const frame: RequestFrame = { type: "req", id: "nested", call, args: { ...source } };
    expect(await dispatch(frame, { type: "process", id: "process" }, context(), deps))
      .toMatchObject({ handled: true, response: { ok: false, error: { message: `Tool execution was not approved: ${call}` } } });
    expect(send).toHaveBeenCalledWith("installation", "process", expect.objectContaining({
      call: "proc.tool.authorize", args: expect.objectContaining({ ...owner, syscall: call, args: source }),
    }));
    expect(read).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
  });

  it("opens an approved nested read and does not reapprove direct tool reads", async () => {
    const send = vi.spyOn(processTransport, "sendFrameToProcess")
      .mockResolvedValue({ type: "res", id: "approval", ok: true, data: { approved: true } });
    const read = vi.spyOn(federation, "handleContactResourceRead")
      .mockResolvedValue({ data: { ok: false, error: "fixture resource" } });
    const frame = (): RequestFrame<"fs.read"> => ({ type: "req", id: "nested", call: "fs.read", args: { ...source } });
    await dispatch(frame(), { type: "process", id: "process" }, context(), deps);
    expect(send).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    const direct = context();
    delete direct.toolOwner;
    await dispatch(frame(), { type: "process", id: "process" }, direct, deps);
    expect(send).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(["deny", "cancel"] as const)("preserves the Shell owner and source signal when a contact copy ends with %s", async (outcome) => {
    const controller = new AbortController();
    const open = vi.spyOn(federation, "openContactResourceSource");
    const send = vi.spyOn(processTransport, "sendFrameToProcess").mockImplementation(async () => {
      if (outcome === "cancel") controller.abort(new Error("copy cancelled"));
      return { type: "res", id: "approval", ok: true, data: { approved: outcome === "cancel" } };
    });
    vi.spyOn(nativeTarget, "dispatchGsvTarget").mockImplementation(async (frame, _ctx, options) => {
      await options.fsTransport!.openContactSource!(source, controller.signal);
      return { type: "res", id: frame.id, ok: true, data: null };
    });
    const ctx = context();
    delete ctx.toolOwner;
    const result = await dispatch({ type: "req", id: "shell", call: "shell.exec", args: { input: "cp contact:alice:/resources/shared /tmp/shared" } },
      { type: "process", id: "process" }, ctx, deps);
    expect(result).toMatchObject({ handled: true, response: { ok: false, error: {
      message: outcome === "deny" ? "Tool execution was not approved: fs.transfer.send" : "copy cancelled",
    } } });
    expect(send).toHaveBeenCalledWith("installation", "process", expect.objectContaining({
      call: "proc.tool.authorize", args: expect.objectContaining({ ...owner, syscall: "fs.transfer.send", args: source }),
    }));
    expect(open).not.toHaveBeenCalled();
  });
});
