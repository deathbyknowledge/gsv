import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getDurableObjectByName } from "../shared/durable-object";
import { describe, expect, it } from "vitest";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";

import type { Kernel } from "../kernel/do";
import type { Process } from "../process/do";
import type { RequestFrame, ResponseFrame } from "../protocol/frames";
import { getKernelPtr, getProcessByPid } from "../shared/utils";
import { processDurableObjectName } from "./routing";

const ROOT_IDENTITY: ProcessIdentity = {
  uid: 0,
  gid: 0,
  gids: [0],
  username: "root",
  home: "/root",
  cwd: "/root",
};

describe("installation-scoped Process history", () => {
  it("routes Kernel history reads to the same scoped Process state", async () => {
    const installationId = "inst_history";
    const pid = `scoped-history-${crypto.randomUUID()}`;
    const storedProcess = await getDurableObjectByName(env.PROCESS, processDurableObjectName(installationId, pid));
    const identityResponse = await storedProcess.recvFrame({
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.setidentity",
      args: { identity: ROOT_IDENTITY },
    } satisfies RequestFrame<"proc.setidentity">);
    expect(identityResponse).toMatchObject({ ok: true, data: { ok: true } });

    await runInDurableObject(storedProcess, (instance: Process, state) => {
      expect(state.id.name).toBe(processDurableObjectName(installationId, pid));
      instance.store.messages.appendMessage("user", "persisted scoped history");
    });

    const currentProcess = await getProcessByPid(pid, installationId);
    expect(currentProcess.id.toString()).toBe(storedProcess.id.toString());

    const kernel = await getKernelPtr(installationId);
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
        messages: [{ role: "user", content: "persisted scoped history" }],
      },
    });
  });
});

function fixtureInternals<T>(instance: Process | Kernel): T {
  // SAFETY: callers name the exact private fixture surface they use; this
  // helper is confined to tests that seed scoped Durable Object state.
  return instance as T;
}
