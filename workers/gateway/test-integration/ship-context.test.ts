import { describe, expect, it } from "vitest";
import { jsonObjectSchema } from "@humansandmachines/gsv/protocol";
import { startProcessRuntimeHarness } from "./process-runtime-harness";

describe("Ship and worker standing context", () => {
  it("boots one account with distinct process prompts and shared owner preferences", async () => {
    const runtime = await startProcessRuntimeHarness();
    try {
      const ship = (await runtime.client.proc.list({})).processes.find(({ personal }) => personal);
      if (!ship) throw new Error("Setup did not create Ship");
      await runtime.client.fs.write({
        path: "/home/process-runtime-user/context.d/20-test-preference.md",
        content: "Shared synthetic owner preference: retain verification evidence.",
      });
      const worker = await runtime.spawn("context worker");
      const child = (await runtime.client.proc.list({})).processes.find(({ pid }) => pid === worker.pid)!;
      expect(child.uid).toBe(ship.uid);
      expect(child.username).toBe(ship.username);
      expect(child.personal).not.toBe(true);

      const prompts: string[] = [];
      for (const pid of [ship.pid, worker.pid]) {
        await runtime.configureAi(pid);
        const before = runtime.ai.requests.length;
        runtime.ai.enqueue({ kind: "tool-calls", calls: [{ id: `finish-${pid}`, name: "Shell", arguments: { input: "yield" } }] });
        const sent = await runtime.client.proc.send({ pid, message: "Read your standing context and finish quietly." });
        if (!sent.ok) throw new Error(sent.error);
        await runtime.waitFor(async () => {
          const history = await runtime.client.proc.history({ pid, includeMessages: false });
          return runtime.ai.requests.length > before && history.ok && history.activeRunId === null;
        }, "context generation to finish");
        prompts.push(JSON.stringify(runtime.ai.requests[before]?.messages.filter((message) =>
          jsonObjectSchema.safeParse(message).data?.role === "system",
        )));
      }

      expect(prompts[0]).toContain("ship/00-role.md");
      expect(prompts[0]).toContain("ship/05-voice.md");
      expect(prompts[0]).not.toContain("worker/00-role.md");
      expect(prompts[1]).toContain("worker/00-role.md");
      expect(prompts[1]).not.toContain("ship/00-role.md");
      expect(prompts[1]).not.toContain("ship/05-voice.md");
      expect(prompts[1]).not.toContain("reply in no more than two sentences");
      for (const prompt of prompts) {
        expect(prompt).toContain("Shared synthetic owner preference");
        expect(prompt).toContain("15-memory.md");
      }
    } finally {
      await runtime.close();
    }
  });
});
