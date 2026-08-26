import type { GSVClient } from "@humansandmachines/gsv/client";
import type {
  ContactSendResult,
  ContactInviteCreateResult,
  ContactInviteSummary,
  ContactRequestRecord,
  ContactRequestState,
  ContactSummary,
  ConversationHistoryResult,
} from "@humansandmachines/gsv/protocol";
import {
  withStagedResources,
  type StagedResourceUpload,
} from "../../../services/gateway/stagedResources";

export type ContactsClient = Pick<GSVClient, "request"> & {
  contact: Pick<GSVClient["contact"], "list" | "revoke" | "send"> & {
    invite: Pick<GSVClient["contact"]["invite"], "accept" | "cancel" | "create" | "list">;
    request: Pick<GSVClient["contact"]["request"], "list" | "update">;
  };
  conversation: Pick<GSVClient["conversation"], "history">;
};

export type ContactsWorkspace = {
  contacts: ContactSummary[];
  invites: ContactInviteSummary[];
  requests: ContactRequestRecord[];
};

export type ContactSendIntent = {
  idempotencyKey: string;
  text: string;
  media: readonly StagedResourceUpload[];
};

export type ContactsWorkspaceMutation =
  | { kind: "invite.create" }
  | { kind: "invite.accept"; code: string }
  | { kind: "invite.cancel"; inviteId: string }
  | { kind: "contact.revoke"; contactId: string }
  | {
      kind: "request.update";
      requestId: string;
      expectedRevision: number;
      state: Exclude<ContactRequestState, "offered">;
    };

export type ContactsMutationResult =
  | { kind: "invite.created"; invite: ContactInviteCreateResult }
  | { kind: "updated" };

export async function loadContactsWorkspace(client: ContactsClient): Promise<ContactsWorkspace> {
  const [contacts, invites, requests] = await Promise.all([
    client.contact.list({ includeRevoked: true }),
    client.contact.invite.list({ includeTerminal: true }),
    client.contact.request.list({ includeTerminal: true }),
  ]);
  return {
    contacts: contacts.contacts,
    invites: invites.invites,
    requests: requests.requests,
  };
}

export async function mutateContactsWorkspace(
  client: ContactsClient,
  mutation: ContactsWorkspaceMutation,
): Promise<ContactsMutationResult> {
  if (mutation.kind === "invite.create") {
    return {
      kind: "invite.created",
      invite: await client.contact.invite.create({}),
    };
  }
  if (mutation.kind === "invite.accept") {
    await client.contact.invite.accept({ code: mutation.code });
    return { kind: "updated" };
  }
  if (mutation.kind === "invite.cancel") {
    await client.contact.invite.cancel({ inviteId: mutation.inviteId });
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
): Promise<ContactSendResult> {
  return withStagedResources(client, intent.media, (media) => client.contact.send({
    contactId,
    text: intent.text,
    ...(media.length > 0 ? { media } : undefined),
    idempotencyKey: intent.idempotencyKey,
  }), intent.idempotencyKey);
}
