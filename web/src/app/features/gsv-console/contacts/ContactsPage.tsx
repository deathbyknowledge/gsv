import type {
  ConversationMessage,
  ContactRequestRecord,
  ContactRequestState,
  ContactInviteSummary,
  ContactSummary,
} from "@humansandmachines/gsv/protocol";
import { contactDisplayName } from "@humansandmachines/gsv/protocol";
import { useEffect, useRef, useState } from "preact/hooks";

import {
  MessageInput,
  type MessageInputAttachment,
} from "../../../components/ui/MessageInput";
import { Button } from "../../../components/ui/Button";
import { TextInput } from "../../../components/ui/TextInput";
import {
  MAX_STAGED_RESOURCE_BYTES,
  type StagedResourceUpload,
} from "../../../services/gateway/stagedResources";
import { ChatMediaAttachment } from "../../chat/components/ChatMediaAttachment";
import { ConsolePage, ConsolePageState } from "../components/ConsolePageTemplate";
import type { ContactSendIntent, ContactsWorkspaceMutation } from "./contactsService";
import { useContactConversation, useContactsWorkspace } from "./useContactsWorkspace";
import "./ContactsPage.css";

export function ContactsPage() {
  const { connected, query, mutation } = useContactsWorkspace();
  const [inviteCode, setInviteCode] = useState("");
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);

  useEffect(() => {
    if (mutation.data?.kind === "invite.created") {
      setCreatedCode(mutation.data.invite.code);
    }
  }, [mutation.data]);

  if (!connected) return <ConsolePageState kind="offline" detail="CONNECTION REQUIRED" />;
  if (query.isLoading) return <ConsolePageState kind="loading" label="LOADING CONTACTS" />;
  if (query.isError || !query.data) {
    return <ConsolePageState kind="error" detail={query.error?.message ?? "CONTACTS"} />;
  }

  const mutate = (input: ContactsWorkspaceMutation): void => mutation.mutate(input);
  const selectedContact = query.data.contacts.find((contact) => (
    contact.id === selectedContactId && contact.state === "active"
  )) ?? null;
  return (
    <ConsolePage className="gsv-contacts-page">
      <div class="gsv-contacts-shell">
        <header class="gsv-contacts-header">
          <div>
            <span class="gsv-sublabel">TRUSTED SHIPS</span>
            <h1>Contacts</h1>
            <p>Pair directly with another GSV, exchange messages and resources, or revoke access.</p>
          </div>
          <span>{query.data.contacts.filter((contact) => contact.state === "active").length} ACTIVE</span>
        </header>

        {mutation.error ? <div class="gsv-contacts-error" role="alert">{mutation.error.message}</div> : null}

        <section class="gsv-contacts-pairing">
          <div>
            <span class="gsv-sublabel">INVITE ANOTHER SHIP</span>
            <h2>Create a one-use pairing code</h2>
            <p>The code expires and only establishes the contact you approve.</p>
            <Button
              label="CREATE INVITE"
              disabled={mutation.isPending}
              onClick={() => mutate({ kind: "invite.create" })}
            />
          </div>
          <form onSubmit={(event) => {
            event.preventDefault();
            const code = inviteCode.trim();
            if (!code || mutation.isPending) return;
            mutation.mutate({ kind: "invite.accept", code }, {
              onSuccess: () => setInviteCode(""),
            });
          }}>
            <TextInput
              label="PAIRING CODE"
              value={inviteCode}
              placeholder="Paste a code from another Ship"
              onChange={setInviteCode}
            />
            <Button type="submit" label="ACCEPT INVITE" disabled={!inviteCode.trim() || mutation.isPending} />
          </form>
        </section>

        {createdCode ? (
          <section class="gsv-contacts-code">
            <div><span class="gsv-sublabel">ONE-USE CODE</span><code>{createdCode}</code></div>
            <Button
              variant="secondary"
              label="COPY"
              onClick={() => void navigator.clipboard.writeText(createdCode)}
            />
          </section>
        ) : null}

        <section>
          <div class="gsv-contacts-section-heading"><span class="gsv-sublabel">INVITATIONS</span></div>
          <div class="gsv-contacts-list">
            {query.data.invites.length === 0
              ? <div class="gsv-contacts-empty">NO RETAINED INVITATIONS</div>
              : null}
            {query.data.invites.map((invite) => (
              <InviteCard
                key={invite.inviteId}
                invite={invite}
                busy={mutation.isPending}
                onCancel={() => mutate({ kind: "invite.cancel", inviteId: invite.inviteId })}
              />
            ))}
          </div>
        </section>

        <section>
          <div class="gsv-contacts-section-heading"><span class="gsv-sublabel">CONTACTS</span></div>
          <div class="gsv-contacts-list">
            {query.data.contacts.length === 0 ? <div class="gsv-contacts-empty">NO CONTACTS YET</div> : null}
            {query.data.contacts.map((contact) => (
              <ContactCard
                key={contact.id}
                contact={contact}
                busy={mutation.isPending}
                confirming={confirmRevoke === contact.id}
                selected={selectedContact?.id === contact.id}
                onOpen={() => setSelectedContactId(contact.id)}
                onAlias={(alias) => mutate({
                  kind: "contact.alias.set",
                  contactId: contact.id,
                  alias,
                })}
                onCancelRevoke={() => setConfirmRevoke(null)}
                onRevoke={() => {
                  if (confirmRevoke !== contact.id) {
                    setConfirmRevoke(contact.id);
                    return;
                  }
                  mutation.mutate({ kind: "contact.revoke", contactId: contact.id }, {
                    onSuccess: () => setConfirmRevoke(null),
                  });
                }}
              />
            ))}
          </div>
        </section>

        {selectedContact ? (
          <ContactConversationPanel
            contact={selectedContact}
            onClose={() => setSelectedContactId(null)}
          />
        ) : null}

        <section>
          <div class="gsv-contacts-section-heading"><span class="gsv-sublabel">CROSS-SHIP REQUESTS</span></div>
          <div class="gsv-contacts-list">
            {query.data.requests.length === 0 ? <div class="gsv-contacts-empty">NO REQUESTS</div> : null}
            {query.data.requests.map((request) => (
              <RequestCard
                request={request}
                busy={mutation.isPending}
                onUpdate={(state) => mutate({
                  kind: "request.update",
                  requestId: request.id,
                  expectedRevision: request.revision,
                  state,
                })}
              />
            ))}
          </div>
        </section>
      </div>
    </ConsolePage>
  );
}

function InviteCard({ invite, busy, onCancel }: {
  invite: ContactInviteSummary;
  busy: boolean;
  onCancel: () => void;
}) {
  return (
    <article class="gsv-contacts-card">
      <div>
        <div class="gsv-contacts-card-meta">
          <span class={`is-${invite.state}`}>{invite.state.toUpperCase()}</span>
          <code>{invite.inviteId}</code>
        </div>
        <p>Expires {new Date(invite.expiresAtMs).toLocaleString()}</p>
      </div>
      {invite.state === "pending" ? (
        <Button variant="dangerGhost" label="CANCEL INVITE" disabled={busy} onClick={onCancel} />
      ) : null}
    </article>
  );
}

function ContactCard({
  contact,
  busy,
  confirming,
  selected,
  onCancelRevoke,
  onAlias,
  onOpen,
  onRevoke,
}: {
  contact: ContactSummary;
  busy: boolean;
  confirming: boolean;
  selected: boolean;
  onCancelRevoke: () => void;
  onAlias: (alias: string | null) => void;
  onOpen: () => void;
  onRevoke: () => void;
}) {
  const [alias, setAlias] = useState(contact.localAlias ?? "");
  useEffect(() => setAlias(contact.localAlias ?? ""), [contact.localAlias]);
  const savedAlias = contact.localAlias ?? "";
  return (
    <article class="gsv-contacts-card">
      <div class="gsv-contacts-card-copy">
        <div class="gsv-contacts-card-meta">
          <span class={`is-${contact.state}`}>{contact.state.toUpperCase()}</span>
          <code>{contact.id}</code>
        </div>
        <h2>{contactDisplayName(contact)}</h2>
        <p>{contact.localAlias ? `${contact.remoteSubject.displayName} · ${contact.remoteOrigin}` : contact.remoteOrigin}</p>
        <form class="gsv-contact-alias" onSubmit={(event) => {
          event.preventDefault();
          const normalized = alias.trim();
          onAlias(normalized || null);
        }}>
          <TextInput
            label="LOCAL ALIAS"
            size="small"
            value={alias}
            placeholder={contact.remoteSubject.displayName}
            maxLength={256}
            disabled={busy}
            onChange={setAlias}
          />
          <Button
            type="submit"
            variant="secondary"
            label={savedAlias ? "UPDATE ALIAS" : "SET ALIAS"}
            disabled={busy || alias.trim() === savedAlias}
          />
        </form>
      </div>
      {contact.state === "active" ? (
        <div class="gsv-contacts-actions">
          <Button
            variant="secondary"
            label={selected ? "OPEN" : "MESSAGE"}
            disabled={busy || selected}
            onClick={onOpen}
          />
          {confirming ? <Button variant="secondary" label="CANCEL" disabled={busy} onClick={onCancelRevoke} /> : null}
          <Button
            variant="dangerGhost"
            label={confirming ? "CONFIRM REVOKE" : "REVOKE"}
            disabled={busy}
            onClick={onRevoke}
          />
        </div>
      ) : null}
    </article>
  );
}

function ContactConversationPanel({ contact, onClose }: {
  contact: ContactSummary;
  onClose: () => void;
}) {
  const { query, mutation } = useContactConversation(contact);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ContactDraftAttachment[]>([]);
  const retryIntent = useRef<ContactDraftSendIntent | null>(null);
  const [attachmentError, setAttachmentError] = useState("");
  const messages = query.data?.messages ?? [];
  const send = (text: string): void => {
    const sentAttachments = attachments;
    const intent = selectContactSendIntent(
      retryIntent.current,
      contact.id,
      text,
      sentAttachments,
    );
    retryIntent.current = intent;
    setAttachments([]);
    mutation.mutate(intent, {
      onError: () => {
        setDraft(text);
        setAttachments((current) => sentAttachments.concat(current));
      },
      onSuccess: () => {
        setDraft("");
        retryIntent.current = null;
      },
    });
  };
  const attach = (files: FileList | readonly File[] | null): void => {
    if (!files?.length) return;
    const selected = Array.from(files);
    const accepted = selected.filter((file) => file.size <= MAX_STAGED_RESOURCE_BYTES);
    setAttachmentError(
      accepted.length === selected.length ? "" : "Attachments cannot exceed 25 MiB.",
    );
    setAttachments((current) => current.concat(accepted.map(contactDraftAttachment)));
  };

  return (
    <section class="gsv-contact-conversation" aria-label={`Conversation with ${contactDisplayName(contact)}`}>
      <header>
        <div>
          <span class="gsv-sublabel">CONTACT CONVERSATION</span>
          <h2>{contactDisplayName(contact)}</h2>
        </div>
        <Button variant="secondary" label="CLOSE" onClick={onClose} />
      </header>
      <div class="gsv-contact-conversation-messages" aria-live="polite">
        {query.isLoading ? <div class="gsv-contacts-empty">LOADING CONVERSATION</div> : null}
        {query.isError ? (
          <div class="gsv-contacts-error" role="alert">{query.error.message}</div>
        ) : null}
        {!query.isLoading && !query.isError && messages.length === 0 ? (
          <div class="gsv-contacts-empty">NO MESSAGES YET</div>
        ) : null}
        {messages.map((message) => (
          <ContactMessage
            key={message.id}
            message={message}
            processId={query.data?.conversation.handlerPid ?? ""}
          />
        ))}
      </div>
      {mutation.error ? (
        <div class="gsv-contacts-error" role="alert">{mutation.error.message}</div>
      ) : null}
      {attachmentError ? <div class="gsv-contacts-error" role="alert">{attachmentError}</div> : null}
      <MessageInput
        attachments={attachments}
        busy={mutation.isPending}
        canSend={Boolean(draft.trim()) || attachments.length > 0}
        disabled={!query.data || query.isError}
        placeholder={`Message ${contactDisplayName(contact)}`}
        value={draft}
        onChange={setDraft}
        onFiles={attach}
        onRemoveAttachment={(id) => {
          setAttachments((current) => current.filter((attachment) => attachment.id !== id));
        }}
        onSend={send}
      />
    </section>
  );
}

function ContactMessage({ message, processId }: {
  message: ConversationMessage;
  processId: string;
}) {
  const remote = message.author.kind === "contact";
  const author = contactMessageAuthor(message);
  return (
    <article class={`gsv-contact-message${remote ? " is-remote" : " is-local"}`}>
      <div class="gsv-contact-message-meta">
        <strong>{author}</strong>
        <time dateTime={new Date(message.createdAt).toISOString()}>
          {new Date(message.createdAt).toLocaleString()}
        </time>
      </div>
      {message.text ? <p>{message.text}</p> : null}
      {message.media?.map((media, index) => (
        <ChatMediaAttachment
          key={`${message.id}:media:${index}`}
          media={media}
          processId={processId}
        />
      ))}
    </article>
  );
}

function contactMessageAuthor(message: ConversationMessage): string {
  if (message.author.kind === "contact") return message.author.displayName;
  if (message.author.kind === "process") return "SHIP";
  return "YOU";
}

type ContactDraftAttachment = StagedResourceUpload & MessageInputAttachment;
type ContactDraftSendIntent = Omit<ContactSendIntent, "media"> & {
  contactId: string;
  media: readonly ContactDraftAttachment[];
};

export function selectContactSendIntent(
  previous: ContactDraftSendIntent | null,
  contactId: string,
  text: string,
  media: readonly ContactDraftAttachment[],
): ContactDraftSendIntent {
  if (
    previous?.contactId === contactId
    && previous.text === text
    && previous.media.length === media.length
    && previous.media.every((attachment, index) => attachment.id === media[index]?.id)
  ) {
    return previous;
  }
  return {
    contactId,
    idempotencyKey: crypto.randomUUID(),
    text,
    media,
  };
}

function contactDraftAttachment(file: File): ContactDraftAttachment {
  const mimeType = file.type || "application/octet-stream";
  return {
    id: crypto.randomUUID(),
    label: file.name || "attachment",
    meta: formatAttachmentSize(file.size),
    type: contactAttachmentType(file),
    mimeType,
    filename: file.name || undefined,
    body: file,
  };
}

function contactAttachmentType(file: File): StagedResourceUpload["type"] {
  const mimeType = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (mimeType.startsWith("image/") || /\.(png|jpg|jpeg|gif|webp)$/.test(name)) return "image";
  if (mimeType.startsWith("audio/") || /\.(mp3|wav|ogg|m4a)$/.test(name)) return "audio";
  if (mimeType.startsWith("video/") || /\.(mp4|mov|webm)$/.test(name)) return "video";
  return "document";
}

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function RequestCard({ request, busy, onUpdate }: {
  request: ContactRequestRecord;
  busy: boolean;
  onUpdate: (state: Exclude<ContactRequestState, "offered">) => void;
}) {
  const actions = requestActions(request);
  return (
    <article class="gsv-contacts-card">
      <div>
        <div class="gsv-contacts-card-meta">
          <span>{request.direction.toUpperCase()} · {request.state.toUpperCase()}</span>
          <code>REV {request.revision}</code>
        </div>
        <h2>{request.title}</h2>
        <p>{request.kind} · {request.contactId}</p>
      </div>
      <div class="gsv-contacts-actions">
        {actions.map((action) => (
          <Button
            key={action.state}
            variant={action.state === "rejected" || action.state === "cancelled" ? "dangerGhost" : "secondary"}
            label={action.label}
            disabled={busy}
            onClick={() => onUpdate(action.state)}
          />
        ))}
      </div>
    </article>
  );
}

function requestActions(request: ContactRequestRecord): Array<{
  state: Exclude<ContactRequestState, "offered">;
  label: string;
}> {
  if (request.state === "offered") {
    return request.direction === "incoming"
      ? [{ state: "accepted", label: "ACCEPT" }, { state: "rejected", label: "REJECT" }]
      : [{ state: "cancelled", label: "CANCEL" }];
  }
  if (request.state === "accepted") {
    return [
      { state: "active", label: "START" },
      { state: "completed", label: "COMPLETE" },
      { state: "cancelled", label: "CANCEL" },
    ];
  }
  if (request.state === "active") {
    return [
      { state: "completed", label: "COMPLETE" },
      { state: "cancelled", label: "CANCEL" },
    ];
  }
  return [];
}
