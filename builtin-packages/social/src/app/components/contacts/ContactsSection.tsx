import { useEffect, useState } from "preact/hooks";
import type {
  EstablishContactArgs,
  PendingAction,
  SendMessageArgs,
  SocialContactDirectory,
  SocialContactSummary,
  SocialState,
} from "../../types";
import { SOCIAL_GRANT_OPTIONS } from "../../types";
import { defaultGrantSelection, grantsFromSelection } from "../../domain/grants";
import {
  formatContactSubject,
  formatPackageRelease,
  formatPackageSource,
  formatShortDate,
  formatVouchSubject,
  humanizeKey,
} from "../../utils/format";
import {
  EmptyState,
  FieldList,
  FieldRow,
  IconButton,
  PaneHeader,
  StatusDot,
  StatusPill,
} from "../ui/primitives";

export function ContactsSection(props: {
  state: SocialState | null;
  selectedContact: SocialContactSummary | null;
  contactDirectory: SocialContactDirectory | null;
  detailOpen: boolean;
  pendingAction: PendingAction | null;
  onSelectContact: (handle: string) => void;
  onEstablishContact: (args: EstablishContactArgs) => void;
  onSaveContactGrants: (args: { handle: string; grants: EstablishContactArgs["grants"] }) => void;
  onRemoveContact: (handle: string) => void;
  onSendMessage: (args: SendMessageArgs) => void;
}) {
  const contacts = props.state?.contacts ?? [];
  return (
    <section class={`social-section social-contacts-section${props.detailOpen ? " is-detail-open" : ""}`}>
      <aside class="social-list-pane">
        <header class="social-list-header">
          <div>
            <p class="social-eyebrow">Known Contacts</p>
            <h1>Contact Trust</h1>
          </div>
          <span>{contacts.length}</span>
        </header>
        <EstablishContactForm
          pending={props.pendingAction === "establish-contact"}
          onEstablishContact={props.onEstablishContact}
        />
        <div class="social-scroll-list">
          {contacts.length ? contacts.map((contact) => (
            <button
              key={contact.handle}
              type="button"
              class={`social-row-button${props.selectedContact?.handle === contact.handle ? " is-active" : ""}`}
              onClick={() => props.onSelectContact(contact.handle)}
            >
              <StatusDot status={contact.acceptsContact ? "active" : "inactive"} />
              <span class="social-row-main">
                <strong>{contact.displayName || contact.handle}</strong>
                <small>{contact.note || contact.handle}</small>
              </span>
              <span class="social-row-count">{contact.grants.length}</span>
            </button>
          )) : <EmptyState title="No known contacts" body="Establish contact with a GSV handle and grant only the operations they need." />}
        </div>
      </aside>

      <ContactDetail
        contact={props.selectedContact}
        directory={props.contactDirectory}
        pendingAction={props.pendingAction}
        onSaveContactGrants={props.onSaveContactGrants}
        onRemoveContact={props.onRemoveContact}
        onSendMessage={props.onSendMessage}
      />
    </section>
  );
}

function ContactDetail(props: {
  contact: SocialContactSummary | null;
  directory: SocialContactDirectory | null;
  pendingAction: PendingAction | null;
  onSaveContactGrants: (args: { handle: string; grants: EstablishContactArgs["grants"] }) => void;
  onRemoveContact: (handle: string) => void;
  onSendMessage: (args: SendMessageArgs) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    setSelected(new Set(props.contact?.grants.map((grant) => grant.operation) ?? []));
  }, [props.contact?.handle, props.contact?.grants]);

  if (!props.contact) {
    return (
      <div class="social-detail-pane">
        <EmptyState title="No contact selected" body="Select a trusted contact to inspect grants, directory signals, and messaging." />
      </div>
    );
  }

  return (
    <section class="social-detail-pane social-contact-detail">
      <PaneHeader
        eyebrow="Trusted Contact"
        title={props.contact.displayName || props.contact.handle}
        meta={(
          <>
            <span>{props.contact.handle}</span>
            <span>Updated {formatShortDate(props.contact.updatedAt)}</span>
          </>
        )}
        actions={(
          <>
            <StatusPill status={props.contact.acceptsContact ? "active" : "inactive"}>
              {props.contact.acceptsContact ? "Mutual Contact Established" : "Contact not accepting"}
            </StatusPill>
            <IconButton
              label="Remove contact"
              glyph="x"
              danger
              disabled={props.pendingAction === "remove-contact"}
              onClick={() => props.onRemoveContact(props.contact!.handle)}
            />
          </>
        )}
      />

      <div class="social-detail-scroll">
        <section class="social-work-section">
          <div class="social-section-head">
            <h3>Contact Grants</h3>
            <button
              type="button"
              class="social-button social-button--primary"
              disabled={props.pendingAction === "save-contact-grants"}
              onClick={() => props.onSaveContactGrants({
                handle: props.contact!.handle,
                grants: grantsFromSelection(selected),
              })}
            >
              Save Contact Grants
            </button>
          </div>
          <GrantChecklist selected={selected} onChange={setSelected} />
        </section>

        <section class="social-work-section">
          <h3>Advertised methods</h3>
          <div class="social-method-grid">
            {props.contact.acceptedSocialMethods.map((method) => (
              <span key={method} class="social-method is-on">{humanizeKey(method)}</span>
            ))}
          </div>
        </section>

        <ContactDirectory directory={props.directory} />

        <section class="social-work-section">
          <h3>Message</h3>
          <MessageForm
            contactHandle={props.contact.handle}
            pending={props.pendingAction === "send-message"}
            onSendMessage={props.onSendMessage}
          />
        </section>

        <section class="social-work-section">
          <h3>Profile</h3>
          <FieldList>
            <FieldRow label="Contact note" value={props.contact.note || "No note"} />
            <FieldRow label="Public handle" value={props.contact.publicHandle || "Not advertised"} />
            <FieldRow label="Synced" value={formatShortDate(props.contact.syncedAt)} />
          </FieldList>
        </section>
      </div>
    </section>
  );
}

function EstablishContactForm(props: {
  pending: boolean;
  onEstablishContact: (args: EstablishContactArgs) => void;
}) {
  const [handle, setHandle] = useState("");
  const [note, setNote] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => defaultGrantSelection());
  return (
    <form
      class="social-establish-contact"
      onSubmit={(event) => {
        event.preventDefault();
        props.onEstablishContact({
          handle,
          note,
          grants: grantsFromSelection(selected),
        });
        setHandle("");
        setNote("");
      }}
    >
      <label>
        <span>Contact handle</span>
        <input value={handle} onInput={(event) => setHandle(event.currentTarget.value)} placeholder="alice.example" />
      </label>
      <label>
        <span>Contact note</span>
        <input value={note} onInput={(event) => setNote(event.currentTarget.value)} placeholder="Alice's GSV" />
      </label>
      <GrantChecklist selected={selected} onChange={setSelected} compact />
      <button class="social-button social-button--primary" type="submit" disabled={props.pending || !handle.trim() || !note.trim()}>
        Establish Contact
      </button>
    </form>
  );
}

function GrantChecklist(props: {
  selected: Set<string>;
  onChange: (selected: Set<string>) => void;
  compact?: boolean;
}) {
  return (
    <div class={`social-grant-list${props.compact ? " is-compact" : ""}`}>
      {SOCIAL_GRANT_OPTIONS.map((option) => (
        <label key={option.operation}>
          <input
            type="checkbox"
            checked={props.selected.has(option.operation)}
            onChange={(event) => {
              const next = new Set(props.selected);
              if (event.currentTarget.checked) {
                next.add(option.operation);
              } else {
                next.delete(option.operation);
              }
              props.onChange(next);
            }}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

function ContactDirectory(props: { directory: SocialContactDirectory | null }) {
  const users = props.directory?.users ?? [];
  const contacts = props.directory?.contacts ?? [];
  const news = props.directory?.news ?? [];
  const packages = props.directory?.packages ?? [];
  const releases = props.directory?.packageReleases ?? [];
  const vouches = props.directory?.vouches ?? [];
  return (
    <section class="social-work-section">
      <div class="social-section-head">
        <h3>Published by contact</h3>
        <span>{users.length} users - {contacts.length} contacts - {news.length} news</span>
      </div>
      <div class="social-directory-grid">
        <section>
          <h4>Users</h4>
          {users.length ? (
            <div class="social-compact-list">
              {users.map((user) => (
                <div key={user.uri ?? `${user.handle}:${user.record.username}`}>
                  <strong>{user.record.displayName || user.record.username}</strong>
                  <span>{user.record.publicHandle || user.handle}</span>
                </div>
              ))}
            </div>
          ) : <p class="social-list-note">No published users visible for this contact.</p>}
        </section>
        <section>
          <h4>Contacts</h4>
          {contacts.length ? (
            <div class="social-compact-list">
              {contacts.map((item) => (
                <div key={item.uri ?? `${item.handle}:${item.record.subject.did}`}>
                  <strong>{formatContactSubject(item.record)}</strong>
                  <span>{item.record.tags?.join(", ") || item.handle}</span>
                </div>
              ))}
            </div>
          ) : <p class="social-list-note">No published contacts visible.</p>}
        </section>
        <section>
          <h4>News</h4>
          {news.length ? (
            <div class="social-compact-list">
              {news.map((item) => (
                <div key={item.uri ?? `${item.handle}:${item.record.createdAt}`}>
                  <strong>{item.record.text}</strong>
                  <span>{formatShortDate(item.record.updatedAt ?? item.record.createdAt)}</span>
                </div>
              ))}
            </div>
          ) : <p class="social-list-note">No contact news visible.</p>}
        </section>
      </div>
      <details class="social-raw-details">
        <summary>Package records ({packages.length})</summary>
        {packages.length ? (
          <div class="social-compact-list">
            {packages.map((item) => (
              <div key={item.uri}>
                <strong>{item.record.displayName || item.record.name}</strong>
                <span>{formatPackageSource(item.record)}</span>
              </div>
            ))}
          </div>
        ) : <p class="social-list-note">No package records visible.</p>}
      </details>
      <details class="social-raw-details">
        <summary>Package releases ({releases.length})</summary>
        {releases.length ? (
          <div class="social-compact-list">
            {releases.map((item) => (
              <div key={item.uri}>
                <strong>{formatPackageRelease(item.record)}</strong>
                <span>{item.record.description || item.record.package.uri}</span>
              </div>
            ))}
          </div>
        ) : <p class="social-list-note">No package releases visible.</p>}
      </details>
      <details class="social-raw-details">
        <summary>Vouches ({vouches.length})</summary>
        {vouches.length ? (
          <div class="social-compact-list">
            {vouches.map((item) => (
              <div key={item.uri}>
                <strong>{formatVouchSubject(item.record)}</strong>
                <span>{item.record.tags?.join(", ") || item.handle}</span>
              </div>
            ))}
          </div>
        ) : <p class="social-list-note">No vouches visible.</p>}
      </details>
    </section>
  );
}

function MessageForm(props: {
  contactHandle: string;
  pending: boolean;
  onSendMessage: (args: SendMessageArgs) => void;
}) {
  const [text, setText] = useState("");
  return (
    <form
      class="social-compose is-inline"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSendMessage({
          toHandle: props.contactHandle,
          text,
        });
        setText("");
      }}
    >
      <label>
        <span>Message</span>
        <textarea value={text} onInput={(event) => setText(event.currentTarget.value)} rows={3} />
      </label>
      <button class="social-button social-button--primary" type="submit" disabled={props.pending || !text.trim()}>
        Send
      </button>
    </form>
  );
}
