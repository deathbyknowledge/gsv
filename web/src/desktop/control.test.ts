import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopControl, type ControlEvent } from "./control";
import { deferred } from "../app/testing/testHarness";

let receive: (event: ControlEvent) => void;
let invoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  invoke = vi.fn(async (command: string) => command === "control_attach" ? "lease" : command === "control_active" ? true : undefined);
  class Channel { constructor(handler: (event: ControlEvent) => void) { receive = handler; } }
  vi.stubGlobal("window", { __TAURI__: { core: { invoke, Channel } } });
});
afterEach(() => vi.unstubAllGlobals());

it("correlates a CLI response through the registered UI owner", async () => {
  const control = desktopControl("generation");
  control.register(["new"], async ({ checkpoint }) => { await checkpoint(); return { type: "created", processId: "proc-one" }; });
  const detach = control.attach();
  receive({ type: "request", id: "request-one", command: { type: "new" } });
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("control_reply", {
    lease: "lease", id: "request-one", reply: { type: "success", response: { type: "created", processId: "proc-one" } },
  }));
  detach();
});

it.each(["cancel", "unmount", "detach"])("%s prevents a late gateway result from changing the view", async (reason) => {
  const gateway = deferred<void>();
  const started = deferred<AbortSignal>();
  const select = vi.fn();
  const control = desktopControl("generation");
  const unregister = control.register(["new"], async ({ checkpoint, signal }) => {
    started.resolve(signal);
    await gateway.promise;
    await checkpoint();
    select();
    return { type: "created", processId: "late" };
  });
  const detach = control.attach();
  receive({ type: "request", id: "pending", command: { type: "new" } });
  const signal = await started.promise;
  if (reason === "cancel") receive({ type: "cancel", id: "pending" });
  else if (reason === "unmount") unregister();
  else detach();
  expect(signal.aborted).toBe(true);
  gateway.resolve();
  await vi.waitFor(() => {
    if (reason === "detach") expect(invoke).toHaveBeenCalledWith("control_detach", { lease: "lease" });
    else expect(invoke).toHaveBeenCalledWith("control_reply", { lease: "lease", id: "pending", reply: { type: "error", code: "conflict" } });
  });
  expect(select).not.toHaveBeenCalled();
  detach();
});

it("rejects a queued command whose native authority expired before delivery", async () => {
  invoke.mockImplementation(async (command: string) => command === "control_attach" ? "lease" : command === "control_active" ? false : undefined);
  const run = vi.fn();
  const control = desktopControl("generation");
  control.register(["new"], run);
  const detach = control.attach();
  receive({ type: "request", id: "expired", command: { type: "new" } });
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("control_reply", { lease: "lease", id: "expired", reply: { type: "error", code: "conflict" } }));
  expect(run).not.toHaveBeenCalled();
  detach();
});
