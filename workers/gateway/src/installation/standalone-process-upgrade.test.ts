import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getDurableObjectByName } from "../shared/durable-object";
import { describe, expect, it } from "vitest";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";

import type { Kernel } from "../kernel/do";
import type { Process } from "../process/do";
import type { RequestFrame, ResponseFrame } from "../protocol/frames";
import { getKernelPtr, getProcessByPid } from "../shared/utils";

const ROOT_IDENTITY: ProcessIdentity = {
  uid: 0,
  gid: 0,
  gids: [0],
  username: "root",
  home: "/root",
  cwd: "/root",
};

describe("standalone Process upgrade compatibility", () => {
  it("routes current Kernel history reads to legacy raw-pid Process state", async () => {
    const pid = `legacy-upgrade-${crypto.randomUUID()}`;
    const legacyProcess = await getDurableObjectByName(env.PROCESS, pid);
    const identityResponse = await legacyProcess.recvFrame({
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.setidentity",
      args: { identity: ROOT_IDENTITY },
    } satisfies RequestFrame<"proc.setidentity">);
    expect(identityResponse).toMatchObject({ ok: true, data: { ok: true } });

    await runInDurableObject(legacyProcess, (instance: Process, state) => {
      expect(state.id.name).toBe(pid);
      const store = fixtureInternals<{
        store: {
          appendMessage(role: "user", content: string): number;
        };
      }>(instance).store;
      store.appendMessage("user", "history persisted before the upgrade");
    });

    const currentProcess = await getProcessByPid(pid);
    expect(currentProcess.id.toString()).toBe(legacyProcess.id.toString());

    const kernel = await getKernelPtr();
    await runInDurableObject(kernel, (instance: Kernel) => {
      const internals = fixtureInternals<{
        caps: { seed(): void };
        procs: {
          spawn(
            processId: string,
            identity: ProcessIdentity,
            options: Record<string, never>,
          ): void;
        };
      }>(instance);
      internals.caps.seed();
      internals.procs.spawn(pid, ROOT_IDENTITY, {});
    });

    // SAFETY: proc.history requests return the protocol's proc.history response frame.
    const response = await kernel.recvFrame(pid, {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.history",
      args: {},
    } satisfies RequestFrame<"proc.history">) as ResponseFrame<"proc.history">;

    expect(response).toMatchObject({
      ok: true,
      data: {
        ok: true,
        pid,
        messageCount: 1,
        messages: [{ role: "user", content: "history persisted before the upgrade" }],
      },
    });
  });
});

function fixtureInternals<T>(instance: Process | Kernel): T {
  // SAFETY: callers name the exact private fixture surface they use; this
  // helper is confined to tests that seed pre-upgrade Durable Object state.
  return instance as T;
}
