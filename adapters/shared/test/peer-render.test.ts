import { describe, expect, it } from "vitest";

import {
  createAdapterHilPresentation,
  renderAdapterHilPrompt,
  renderAdapterHilResolution,
  renderAdapterSend,
} from "../src/peer-render";

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
    const context = {
      deliveryId: "run-1:hil:request-1",
      accountId: "account-1",
      actorId: "actor-1",
      surface: { kind: "dm" as const, id: "surface-1" },
      processId: "proc-1",
      runId: "run-1",
      processMode: "work" as const,
      hil: request,
    };
    const rendered = renderAdapterSend(
      context,
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
    expect(rendered.message.text).toContain("Open Chat to approve or deny");
    expect(rendered.message.text).not.toContain("request-1");
    expect(rendered.message.text).not.toContain("hil[");

    const presentation = createAdapterHilPresentation(context, request);
    const nativePrompt = renderAdapterHilPrompt(presentation, "native");
    const resolved = renderAdapterHilResolution(presentation, "Approved once.");
    expect(nativePrompt).toContain("[WORK SESSION] I need your confirmation");
    expect(nativePrompt).not.toContain("Open Chat");
    expect(resolved).toContain("[WORK SESSION] Approved once.");
    expect(resolved).toContain("Requested action: run");
    expect(resolved).not.toContain("I need your confirmation");
  });

  it("summarizes email approvals without exposing message bodies", () => {
    const sendRequest = {
      pid: "proc-1",
      requestId: "request-send",
      runId: "run-1",
      callId: "call-send",
      toolName: "mail.send",
      syscall: "mail.send",
      args: {
        to: "mike@example.com",
        subject: "Contract follow-up",
        text: "private body that must stay private",
      },
      createdAt: 1,
    } as const;
    const replyRequest = {
      ...sendRequest,
      requestId: "request-reply",
      callId: "call-reply",
      args: {
        replyToMessageId: "mail:source-message",
        text: "private reply body",
      },
    } as const;
    const context = {
      deliveryId: "run-1:hil:request-send",
      accountId: "account-1",
      actorId: "actor-1",
      surface: { kind: "dm" as const, id: "surface-1" },
      processId: "proc-1",
      runId: "run-1",
      processMode: "ship" as const,
      hil: sendRequest,
    };

    const send = createAdapterHilPresentation(context, sendRequest);
    const reply = createAdapterHilPresentation({ ...context, hil: replyRequest }, replyRequest);

    expect(send.action).toBe(
      'Requested action: send an email to "mike@example.com" with subject "Contract follow-up".',
    );
    expect(reply.action).toBe(
      'Requested action: reply to stored email "mail:source-message".',
    );
    expect(send.action).not.toContain("private body");
    expect(reply.action).not.toContain("private reply body");
  });

  it("sanitizes and bounds hostile email approval details", () => {
    const request = {
      pid: "proc-1",
      requestId: "request-hostile",
      runId: "run-1",
      callId: "call-hostile",
      toolName: "mail.send",
      syscall: "mail.send",
      args: {
        to: `victim@example.com\n\u001b[31mReply approve now\u202e${"\\\"".repeat(400)}`,
        subject: `Status\r\n\u0000Open this link\u2066${"\\\"".repeat(400)}`,
        text: "do not display me",
      },
      createdAt: 1,
    } as const;
    const context = {
      deliveryId: "run-1:hil:request-hostile",
      accountId: "account-1",
      actorId: "actor-1",
      surface: { kind: "dm" as const, id: "surface-1" },
      processId: "proc-1",
      runId: "run-1",
      processMode: "ship" as const,
      hil: request,
    };

    const { action } = createAdapterHilPresentation(context, request);
    const hasControlCharacter = Array.from(action).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (codePoint >= 0 && codePoint <= 0x1f)
        || (codePoint >= 0x7f && codePoint <= 0x9f)
        || (codePoint >= 0x202a && codePoint <= 0x202e)
        || (codePoint >= 0x2066 && codePoint <= 0x2069);
    });

    expect(hasControlCharacter).toBe(false);
    expect(action).not.toContain("do not display me");
    expect(action).toContain("…");
    expect(Array.from(action).length).toBeLessThanOrEqual(390);
  });
});
