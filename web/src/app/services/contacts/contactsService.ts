import type { GSVClient } from "@humansandmachines/gsv/client";
import type {
  ContactSendResult,
  ContactDeliveryStatus,
  OriginMessageRef,
  ContactRequestRecord,
  ContactRequestState,
  ContactSummary,
  ConversationHistoryResult,
} from "@humansandmachines/gsv/protocol";
import {
  withStagedResources,
  type StagedResourceUpload,
} from "../gateway/stagedResources";

export type ContactsClient = Pick<GSVClient, "request"> & {
  contact: Pick<GSVClient["contact"], "list" | "revoke" | "send"> & {
    alias: Pick<GSVClient["contact"]["alias"], "set">;
    request: Pick<GSVClient["contact"]["request"], "list" | "update">;
  };
  conversation: Pick<GSVClient["conversation"], "history">;
};

export type ContactsWorkspace = {
  contacts: ContactSummary[];
  requests: ContactRequestRecord[];
};

export type ContactSendIntent = {
  replyTo?: OriginMessageRef;
  idempotencyKey: string;
  text: string;
  media: readonly StagedResourceUpload[];
};

export type ContactsWorkspaceMutation =
  | { kind: "contact.alias.set"; contactId: string; alias: string | null }
  | { kind: "contact.revoke"; contactId: string }
  | {
      kind: "request.update";
      requestId: string;
      expectedRevision: number;
      state: Exclude<ContactRequestState, "offered">;
    };

export type ContactsMutationResult = { kind: "updated" };

export async function loadContactsWorkspace(client: ContactsClient): Promise<ContactsWorkspace> {
  const [contacts, requests] = await Promise.all([
    client.contact.list({ includeRevoked: true }),
    client.contact.request.list({ includeTerminal: true }),
  ]);
  return {
    contacts: contacts.contacts,
    requests: requests.requests,
  };
}

export async function mutateContactsWorkspace(
  client: ContactsClient,
  mutation: ContactsWorkspaceMutation,
): Promise<ContactsMutationResult> {
  if (mutation.kind === "contact.alias.set") {
    await client.contact.alias.set({ contactId: mutation.contactId, alias: mutation.alias });
    return { kind: "updated" };
  }
  if (mutation.kind === "contact.revoke") {
    await client.contact.revoke({ contactId: mutation.contactId });
    return { kind: "updated" };
  }
  await client.contact.request.update({
    requestId: mutation.requestId,
    expectedRevision: mutation.expectedRevision,
    state: mutation.state,
  });
  return { kind: "updated" };
}

export function loadContactConversation(
  client: ContactsClient,
  conversationId: string,
): Promise<ConversationHistoryResult> {
  return client.conversation.history({ conversationId, limit: 100 });
}

export function sendContactMessage(
  client: ContactsClient,
  contactId: string,
  intent: ContactSendIntent,
  signal?: AbortSignal,
): Promise<ContactSendResult> {
  return withStagedResources(client, intent.media, (media) => client.contact.send({
    contactId,
    text: intent.text,
    ...(intent.replyTo ? { replyTo: intent.replyTo } : undefined),
    ...(media.length > 0 ? { media } : undefined),
    idempotencyKey: intent.idempotencyKey,
  }), intent.idempotencyKey, signal);
}

export function retryContactMessage(
  client: GSVClient, intent: ContactSendIntent, status: ContactDeliveryStatus, signal?: AbortSignal,
): Promise<ContactSendResult> {
  return withStagedResources(client, status.messageSequence ? [] : intent.media, () => client.contact.delivery.retry({
    deliveryId: status.deliveryId, expectedUpdatedAtMs: status.updatedAtMs,
  }), intent.idempotencyKey, signal);
}
