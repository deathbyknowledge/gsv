import { describe, expect, it } from "vitest";
import { startProcessRuntimeHarness } from "./process-runtime-harness";

// Waits on the real clock through the real sandbox, so it only runs when asked:
// NESTED_APPROVAL_WAIT_MS=130000 npx vitest run --config vitest.integration.config.ts nested-approval-wait
const WAIT_MS = Number(process.env.NESTED_APPROVAL_WAIT_MS ?? 0);

describe.skipIf(!WAIT_MS)("nested approval answered after a long wait", () => {
  it.each(["Shell", "CodeMode"])("%s mail is sent", async (tool) => {
    const runtime = await startProcessRuntimeHarness({ managedMailQueue: "nested-approval-wait" });
    const deliveryId = `wait-${tool.toLowerCase()}`;
    try {
      const spawned = await runtime.spawn("Nested approval wait");
      await runtime.configureAi(spawned.pid);
      await runtime.client.proc.observe({ pid: spawned.pid });
      runtime.ai.enqueue(
        { kind: "tool-calls", calls: [{ id: "send-mail", name: tool, arguments: tool === "Shell" ? {
          input: `mail send --to recipient@example.invalid --subject Hello --message 'A synthetic message' --delivery-id ${deliveryId}`,
          purpose: "Send the requested email",
        } : {
          code: `return await mail.send({ to: "recipient@example.invalid", subject: "Hello", text: "A synthetic message", deliveryId: "${deliveryId}" });`,
          purpose: "Send the requested email",
        } }] },
        { kind: "tool-calls", calls: [{ id: "yield", name: "Shell", arguments: { input: "yield" } }] },
      );
      const sent = await runtime.client.proc.send({ pid: spawned.pid, message: "Send an email." });
      if (!sent.ok) throw new Error(sent.error);
      await runtime.waitFor(() => runtime.signals.some(({ signal, payload }) => signal === "proc.run.hil.requested"
        && payload.syscall === "mail.send"), "mail approval", 15_000);
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
      const history = await runtime.client.proc.history({ pid: spawned.pid, includeMessages: false });
      if (!history.ok || !history.pendingHil) throw new Error(`Approval was gone after ${WAIT_MS}ms`);
      const answered = await runtime.client.proc.hil({ pid: spawned.pid, requestId: history.pendingHil.requestId, decision: "approve" });
      if (!answered.ok) throw new Error(`Approval answer refused after ${WAIT_MS}ms: ${answered.error}`);
      await runtime.waitFor(async () => {
        const state = await runtime.client.proc.history({ pid: spawned.pid, includeMessages: false });
        return state.ok && state.activeRunId === null;
      }, "approved mail completion", 30_000);
      const status = await runtime.client.mail.status({ deliveryId });
      expect(status.outbound).not.toBeNull();
    } finally { await runtime.close(); }
  }, WAIT_MS + 120_000);
});
