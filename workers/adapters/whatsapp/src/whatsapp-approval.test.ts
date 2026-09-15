import { describe, expect, it, vi } from "vitest";

import type { ProcHilRequest } from "../../../../packages/gsv/src/protocol/syscalls/proc";
import type { AdapterGatewayBinding } from "../../shared/src/gateway-rpc";
import { runAdapterHilSqlMigrations } from "../../shared/src/schema/migrations";
import { TestDurableObjectStorage } from "../../shared/test/sqlite-storage";
import type { AdapterDeliveryContext, GatewayFrame } from "./types";
import {
  buildWhatsAppInteractivePayload,
  describeWhatsAppApproval,
  handleWhatsAppApprovalReply,
  prepareWhatsAppApproval,
} from "./whatsapp-approval";

const REQUEST: ProcHilRequest = {
  pid: "proc-1",
  requestId: "request-1",
  runId: "run-1",
  callId: "call-1",
  toolName: "Shell",
  syscall: "shell.exec",
  target: "gsv",
  args: { input: "date" },
  createdAt: 1_700_000_000_000,
};
const CONTEXT: AdapterDeliveryContext = {
  deliveryId: "run-1:hil:request-1",
  accountId: "managed",
  actorId: "34611111189",
  surface: { kind: "dm", id: "34611111189" },
  routeGeneration: "generation-1",
  processId: "proc-1",
  runId: "run-1",
  processMode: "ship",
  hil: REQUEST,
};

function storage(): DurableObjectStorage {
  const fixture = new TestDurableObjectStorage().asDurableStorage();
  runAdapterHilSqlMigrations(fixture);
  return fixture;
}

describe("WhatsApp approval buttons", () => {
  it("renders at most three short reply buttons bound to one persisted token", async () => {
    const controls = await prepareWhatsAppApproval(storage(), describeWhatsAppApproval(CONTEXT, REQUEST));
    expect(controls).not.toBeNull();
    expect(controls!.text).toContain("Requested action: run \"date\".");
    expect(controls!.buttons).toHaveLength(3);
    expect(controls!.buttons.every((button) => [...button.title].length <= 20)).toBe(true);
    expect(controls!.buttons.map((button) => button.id)).toEqual([
      `gsvh:${controls!.token}:o`,
      `gsvh:${controls!.token}:a`,
      `gsvh:${controls!.token}:d`,
    ]);
    expect(buildWhatsAppInteractivePayload("34611111189", controls!, "wamid.in")).toEqual({
      to: "34611111189",
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: controls!.text },
        action: {
          buttons: [
            { type: "reply", reply: { id: `gsvh:${controls!.token}:o`, title: "Approve once" } },
            { type: "reply", reply: { id: `gsvh:${controls!.token}:a`, title: "Always approve" } },
            { type: "reply", reply: { id: `gsvh:${controls!.token}:d`, title: "Deny" } },
          ],
        },
      },
      context: { message_id: "wamid.in" },
    });
  });

  it("falls back to plain text when the prompt exceeds the interactive body limit", async () => {
    const longRequest = { ...REQUEST, args: { input: "x".repeat(1_100) } };
    const source = describeWhatsAppApproval({ ...CONTEXT, hil: longRequest }, longRequest);
    expect(await prepareWhatsAppApproval(storage(), source)).toBeNull();
    // The stored source keeps the request identity and its presentation, never the arguments.
    expect(JSON.stringify(source)).not.toContain("\"args\"");
    expect(source.request).toEqual({ pid: "proc-1", requestId: "request-1", runId: "run-1" });
  });

  it("submits a reply button through the linked-human proc.hil path and answers with the decision", async () => {
    const store = storage();
    const controls = (await prepareWhatsAppApproval(store, describeWhatsAppApproval(CONTEXT, REQUEST)))!;
    const linkedPeerFrame = vi.fn<AdapterGatewayBinding["linkedPeerFrame"]>(async (_installation, _context, frame) => ({
      type: "res",
      id: frame.id,
      ok: true,
      data: { ok: true, pid: "proc-1", requestId: "request-1", decision: "approve", resumed: true, remembered: true },
    }));
    const gateway: AdapterGatewayBinding = {
      linkedPeerFrame,
      serviceFrame: async (): Promise<GatewayFrame | null> => null,
    };
    const status = await handleWhatsAppApprovalReply(store, gateway, { installationId: "installation_test" }, {
      interactionId: "wamid.reply",
      actorId: "34611111189",
      surfaceId: "34611111189",
      providerMessageId: "wamid.prompt",
      data: `gsvh:${controls.token}:a`,
    });
    expect(status).toContain("Approved for this conversation.");
    expect(status).toContain("Requested action: run \"date\".");
    expect(linkedPeerFrame).toHaveBeenCalledWith(
      { installationId: "installation_test" },
      expect.objectContaining({ accountId: "managed", actorId: "34611111189", routeGeneration: "generation-1", interactionId: "wamid.reply" }),
      expect.objectContaining({ call: "proc.hil", args: { pid: "proc-1", requestId: "request-1", decision: "approve", remember: true } }),
    );

    expect(await handleWhatsAppApprovalReply(store, gateway, { installationId: "installation_test" }, {
      interactionId: "wamid.replay",
      actorId: "34611111189",
      surfaceId: "34611111189",
      providerMessageId: "wamid.prompt",
      data: `gsvh:${controls.token}:a`,
    })).toContain("Approved for this conversation.");
    expect(linkedPeerFrame).toHaveBeenCalledOnce();
    expect(await handleWhatsAppApprovalReply(store, gateway, { installationId: "installation_test" }, {
      interactionId: "wamid.other",
      actorId: "34611111189",
      surfaceId: "34611111189",
      providerMessageId: "wamid.prompt",
      data: "gsvh:0000000000000000:d",
    })).toBe("This approval is no longer available.");
    expect(await handleWhatsAppApprovalReply(store, gateway, { installationId: "installation_test" }, {
      interactionId: "wamid.junk",
      actorId: "34611111189",
      surfaceId: "34611111189",
      providerMessageId: "wamid.prompt",
      data: "not-a-button",
    })).toBeNull();
  });
});
