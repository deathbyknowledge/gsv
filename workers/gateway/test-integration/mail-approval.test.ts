import { describe, expect, it } from "vitest";
import { startProcessRuntimeHarness } from "./process-runtime-harness";

describe("mail approval", () => {
  it.each(["Shell", "CodeMode"])("shows the %s mail approval on the live connection and leaves mail unsent when denied", async (tool) => {
    const runtime = await startProcessRuntimeHarness({ managedMailQueue: "mail-approval-test" });
    try {
      const process = await runtime.spawn("Mail approval");
      await runtime.configureAi(process.pid);
      await runtime.client.proc.observe({ pid: process.pid });
      runtime.ai.enqueue(
        { kind: "tool-calls", calls: [{ id: "send-mail", name: tool, arguments: tool === "Shell" ? {
          input: "mail send --to recipient@example.invalid --subject Hello --message 'A synthetic message' --delivery-id approval-test",
          purpose: "Send the requested email",
        } : {
          code: 'return await mail.send({ to: "recipient@example.invalid", subject: "Hello", text: "A synthetic message", deliveryId: "approval-test" });',
          purpose: "Send the requested email",
        } }] },
        { kind: "tool-calls", calls: [{ id: "yield", name: "Shell", arguments: { input: "yield" } }] },
      );
      const sent = await runtime.client.proc.send({ pid: process.pid, message: "Send an email." });
      if (!sent.ok) throw new Error(sent.error);
      await runtime.waitFor(() => runtime.signals.some(({ signal, payload }) => signal === "proc.run.hil.requested"
        && payload.syscall === "mail.send"), "mail approval on the browser connection", 15000);
      const requested = runtime.signals.find(({ signal, payload }) => signal === "proc.run.hil.requested"
        && payload.syscall === "mail.send")!;
      const history = await runtime.client.proc.history({ pid: process.pid, includeMessages: false });
      if (!history.ok || !history.pendingHil) throw new Error("Mail approval missing from process history");
      const request = history.pendingHil;
      expect(requested.payload).toMatchObject({
        pid: process.pid, requestId: request.requestId, syscall: "mail.send", target: "gsv",
        args: { to: "recipient@example.invalid", subject: "Hello" },
      });
      expect(await runtime.client.mail.status({ deliveryId: "approval-test" })).toEqual({ outbound: null });
      expect(await runtime.client.proc.hil({ pid: process.pid, requestId: request.requestId, decision: "deny" }))
        .toMatchObject({ ok: true });
      await runtime.waitFor(async () => {
        const state = await runtime.client.proc.history({ pid: process.pid, includeMessages: false });
        return state.ok && state.activeRunId === null && state.pendingHil === null;
      }, "denied mail completion", 15000);
      expect(await runtime.client.mail.status({ deliveryId: "approval-test" })).toEqual({ outbound: null });
    } finally { await runtime.close(); }
  });
});
