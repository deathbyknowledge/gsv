import { originMessageRefSchema } from "@humansandmachines/gsv/protocol";
import { getConversationById, sendFrameToProcess } from "../shared/utils";
import type { InternalRequestFrame } from "../protocol/process-frames";
import type { KernelContext } from "./context";
import { hasCapability } from "./capabilities";
import { notifyProcessChanged } from "./process-notifications";

export async function processScopeMessages(ctx: KernelContext): Promise<void> {
  const admission = ctx.procs.scopes.automation;
  for (const item of admission.due()) {
    const scope = ctx.procs.scopes.get(item.scope_id);
    if (!scope?.policy.automatic || scope.state !== "active") continue;
    const policy = scope.policy.automatic;
    const grant = scope.policy.conversations[0];
    const current = () => {
      const record = ctx.procs.get(scope.rootPid);
      const activeScope = ctx.procs.scopes.requireActive(scope.id, scope.revision);
      const contact = ctx.federation.get(grant.contactId);
      if (!record || record.scopeId !== scope.id || !ctx.auth.getPasswdByUid(scope.ownerUid) || !ctx.auth.getPasswdByUid(record.uid)
        || ctx.auth.isAccountDisabled(scope.ownerUid) || ctx.auth.isAccountDisabled(record.uid)
        || !contact || contact.ownerUid !== scope.ownerUid || contact.state !== "active" || contact.generation !== grant.generation
        || contact.preferences.muted) throw new Error("conversation or helper access ended");
      const calls = ctx.caps.resolve(record.gids);
      if (!hasCapability(calls, "ai.text.generate") || (policy.mode === "reply" && !hasCapability(calls, "contact.send"))) throw new Error("required account permission ended");
      if (activeScope.used.generations >= activeScope.policy.budgets.generations) throw new Error("model-request allowance used");
      return contact;
    };
    try { current(); } catch (error) {
      admission.pause(scope.id, error instanceof Error ? error.message : "helper access needs review");
      notifyProcessChanged(ctx, scope.rootPid, ["scope"]);
      continue;
    }
    if (!admission.current(item)) continue;
    try {
      const history = await getConversationById(ctx.installationId, grant.conversationId).history({ beforeSequence: item.message_sequence + 1, limit: 1 });
      const message = history.messages[0];
      if (!message || message.id !== item.message_id || message.author.kind !== "contact" || message.author.contactId !== grant.contactId) {
        admission.pause(scope.id, "selected incoming message is unavailable");
        notifyProcessChanged(ctx, scope.rootPid, ["scope"]);
        continue;
      }
      const contact = current();
      if (!admission.current(item)) continue;
      admission.reserveAdmission(item, policy.intervalSeconds);
      const request: InternalRequestFrame<"proc.runtime.event.deliver"> = {
        type: "req", id: item.event_id, call: "proc.runtime.event.deliver", args: {
          eventId: item.event_id, event: { type: "social.message", payload: {
            eventId: item.event_id, scopeId: scope.id, conversationId: grant.conversationId, contactId: contact.id,
            mode: policy.mode, ownerRequest: policy.request, reference: originMessageRefSchema.parse(JSON.parse(item.reference_json)),
            message: { sender: contact.remoteSubject.displayName, text: message.text, contentTrust: "untrusted", attachmentsIncluded: false },
          } },
        },
      };
      const response = await sendFrameToProcess(ctx.installationId, scope.rootPid, request);
      if (response?.type !== "res" || !response.ok || response.id !== request.id) throw new Error("Helper event admission is unconfirmed");
      admission.admitted(item, policy);
    } catch {
      admission.failed(item);
    }
    notifyProcessChanged(ctx, scope.rootPid, ["scope"]);
  }
}
