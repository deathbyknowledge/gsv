/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Kernel } from "./do";
import { handleShellExec } from "../drivers/native/shell";
import { handleAiContext, handleAiTools } from "./ai";
import { handleProcSpawn } from "./proc-handlers";

describe("scoped Process syscall boundaries", () => {
  it("keeps shell, discovery and descendants inside the same grant", async () => {
    const stub = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
    await runInDurableObject(stub, async (kernel: Kernel) => {
      const pid = `proc:${crypto.randomUUID()}`;
      const scope = kernel.federation.transaction(() => kernel.procs.scopes.create(0, pid, {
        conversations: [], resources: [], materials: [{ name: "selected.txt", text: "only selected material" }],
        expiresAtMs: Date.now() + 60_000, budgets: { processes: 1, generations: 4, messages: 0 },
      }));
      kernel.federation.transaction(() => {
        kernel.procs.scopes.consume(scope.id, "processes", pid, 1);
        kernel.procs.spawn(pid, { uid: 0, gid: 0, gids: [0], username: "root", home: "/var/scopes/test", cwd: "/materials" }, { scopeId: scope.id });
      });
      const ctx = kernel.buildProcessContext(pid)!;
      kernel.procs.spawn("proc:private", { uid: 0, gid: 0, gids: [0], username: "root", home: "/root", cwd: "/root" }, { label: "Private process label" });
      const selected = await handleShellExec({ input: "cat /materials/selected.txt" }, ctx);
      expect(selected.output).toContain("only selected material");
      const processes = await handleShellExec({ input: "proc list" }, ctx);
      expect(processes.output).toContain(pid);
      expect(processes.output).not.toContain("Private process label");
      const access = await handleShellExec({ input: "proc scope --json" }, ctx);
      expect(access.output).toContain(scope.id);
      const privateRead = await handleShellExec({ input: "cat /etc/shadow" }, ctx);
      expect(privateRead).not.toMatchObject({ status: "completed", exitCode: 0 });
      const ipc = await handleShellExec({ input: "proc ipc send proc:private --message 'outside'" }, ctx);
      expect(ipc).not.toMatchObject({ status: "completed", exitCode: 0 });
      const context = await handleAiContext({}, ctx);
      expect(context).toMatchObject({ targets: [], mcpServers: [], skillIndex: [], skillIndexMode: "off" });
      const tools = await handleAiTools(ctx);
      expect(tools.targets).toEqual([]);
      expect(tools.tools.map((tool) => tool.name)).not.toContain("Write");
      const escaped = await handleProcSpawn({ parentPid: "proc:other", runAs: "root" }, ctx);
      expect(escaped.ok).toBe(false);
      const exhausted = await handleProcSpawn({}, ctx);
      expect(exhausted.ok).toBe(false);
      if (!exhausted.ok) expect(exhausted.error).toContain("allowance is exhausted");
      kernel.procs.scopes.revoke(scope.id, 0, 1);
      await expect(handleAiContext({}, ctx)).rejects.toThrow("no longer active");
    });
  });
});
