import { describe, expect, it } from "vitest";

import { renderAdapterSend } from "../src/peer-render";

describe("renderAdapterSend", () => {
  it("bounds and sanitizes approval details for provider presentation", () => {
    const request = {
      pid: "proc-1",
      requestId: "request-1",
      runId: "run-1",
      callId: "call-1",
      toolName: "Shell",
      syscall: "shell.exec",
      target: "gsv",
      args: { input: `echo\u202e${"x".repeat(10_000)}` },
      createdAt: 1,
    } as const;
    const rendered = renderAdapterSend(
      {
        deliveryId: "run-1:hil:request-1",
        accountId: "account-1",
        actorId: "actor-1",
        surface: { kind: "dm", id: "surface-1" },
        processId: "proc-1",
        runId: "run-1",
        hil: request,
      },
      {
        deliveryId: "run-1:hil:request-1",
        surface: { kind: "dm", id: "surface-1" },
        actorId: "actor-1",
        text: "",
      },
    );

    expect(rendered.message.text.length).toBeLessThan(2_000);
    expect(rendered.message.text).not.toContain("\u202e");
    expect(rendered.message.text).toContain("…");
    expect(rendered.message.text).toContain("approve hil[request-1]");
    expect(rendered.message.text).toContain("approve always hil[request-1]");
    expect(rendered.message.text).toContain("deny hil[request-1]");
  });
});
