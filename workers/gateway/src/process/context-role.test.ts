import { describe, expect, it, vi } from "vitest";
import type { AiContextResult } from "@humansandmachines/gsv/protocol";
import type { Process } from "./do";
import type { RunState } from "./run/state";
import { initProcess, responsibilityKernelResult, ROOT_IDENTITY, runInProcess, terminalTestConfig } from "./do-test-harness";

describe("Process context roles", () => {
  it("keeps normal Ship runs in one epoch and archives context when a bounded call uses the worker role", async () => {
    const pid = "context-role-epochs";
    const stub = await initProcess(pid, ROOT_IDENTITY, { register: false });
    await runInProcess(stub, async (process: Process) => {
      // SAFETY: this fixture only serves the responsibility calls made while constructing epochs.
      process.kernel.kernelRpc = vi.fn(async (call: string) => {
        const result = responsibilityKernelResult(call);
        if (result) return result;
        throw new Error(`unexpected Kernel call: ${call}`);
      }) as typeof process.kernel.kernelRpc;
      const config = terminalTestConfig(pid);
      const snapshot: AiContextResult = {
        processRole: "ship", targets: [], mcpServers: [], system: { timezone: "UTC" }, skillIndexMode: "off",
        systemContextFiles: [
          { name: "common.md", text: "Shared facts" },
          { name: "ship/voice.md", text: "Ship voice only" },
          { name: "worker/work.md", text: "Worker result detail" },
        ],
      };
      const makeRun = (runId: string, returnToCaller = false): RunState => ({
        runId, returnToCaller, tools: [], config,
        approvalPolicy: { default: "auto", rules: [] },
      });
      let run = makeRun("ship-first");
      process.runs.active = run;
      const ship = (await process.history.ensureContextEpoch(run.runId, run, config, snapshot))!;
      expect(ship.systemPrompt).toContain("Ship voice only");
      expect(ship.systemPrompt).not.toContain("Worker result detail");

      run = makeRun("ship-again");
      process.runs.active = run;
      expect((await process.history.ensureContextEpoch(run.runId, run, config, snapshot))?.id).toBe(ship.id);

      run = makeRun("bounded-call", true);
      process.runs.active = run;
      const worker = (await process.history.ensureContextEpoch(run.runId, run, config, snapshot))!;
      expect(worker.id).not.toBe(ship.id);
      expect(worker.sourceManifest.processRole).toBe("worker");
      expect(worker.systemPrompt).toContain("Shared facts");
      expect(worker.systemPrompt).toContain("Worker result detail");
      expect(worker.systemPrompt).not.toContain("Ship voice only");
      expect(process.store.epochs.getContextEpoch(ship.id)?.systemPrompt).toBe(ship.systemPrompt);

      run = makeRun("ship-resumed");
      process.runs.active = run;
      const resumed = (await process.history.ensureContextEpoch(run.runId, run, config, snapshot))!;
      expect(resumed.id).not.toBe(worker.id);
      expect(resumed.systemPrompt).toBe(ship.systemPrompt);

      // An in-flight epoch from the older build must also acquire a role.
      const legacyManifest = { ...resumed.sourceManifest };
      delete legacyManifest.processRole;
      process.store.sql.exec("UPDATE context_epochs SET source_manifest_json = ? WHERE epoch_id = ?", JSON.stringify(legacyManifest), resumed.id);
      const upgraded = (await process.history.ensureContextEpoch(run.runId, run, config, snapshot))!;
      expect(upgraded.id).not.toBe(resumed.id);
      expect(upgraded.sourceManifest.processRole).toBe("ship");
    });
  });

  it("refreshes an existing Process account name without changing its uid, home or working directory", async () => {
    const identity = { ...ROOT_IDENTITY, uid: 1001, gid: 1001, gids: [1001], username: "algo", home: "/home/algo", cwd: "/home/algo/work" };
    const pid = "context-role-identity";
    const stub = await initProcess(pid, identity, { register: false });
    await runInProcess(stub, async (process: Process) => {
      // SAFETY: resolveAiContext is the only RPC invoked; the fixture supplies that exact response.
      process.kernel.kernelRpc = vi.fn(async () => ({
        targets: [], mcpServers: [], system: { timezone: "UTC" }, skillIndexMode: "off", processRole: "worker",
        identity: { ...identity, username: "ship", repoOwner: "algo", cwd: identity.home },
      })) as typeof process.kernel.kernelRpc;
      await process.settings.resolveAiContext();
      expect(process.identity).toEqual({ ...identity, username: "ship", repoOwner: "algo" });
    });
  });
});
