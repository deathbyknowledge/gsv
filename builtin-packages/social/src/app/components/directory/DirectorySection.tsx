import type {
  PendingAction,
  SocialContactDirectory,
  SocialContactSummary,
  SocialState,
} from "../../types";
import {
  formatContactSubject,
  formatPackageRelease,
  formatPackageSource,
  formatShortDate,
  formatVouchSubject,
} from "../../utils/format";
import {
  EmptyState,
  FieldList,
  FieldRow,
  PaneHeader,
  StatusDot,
  StatusPill,
  StructuredDetails,
} from "../ui/primitives";

export function DirectorySection(props: {
  state: SocialState | null;
  selectedContact: SocialContactSummary | null;
  contactDirectory: SocialContactDirectory | null;
  detailOpen: boolean;
  pendingAction: PendingAction | null;
  onSelectContact: (handle: string) => void;
  onRepublishPublicRecords: () => void;
}) {
  const identity = props.state?.identity ?? null;
  const contacts = props.state?.contacts ?? [];
  return (
    <section class={`social-section social-directory-section${props.detailOpen ? " is-detail-open" : ""}`}>
      <aside class="social-list-pane">
        <header class="social-list-header">
          <div>
            <p class="social-eyebrow">Directory</p>
            <h1>Published Records</h1>
          </div>
          <button
            type="button"
            class="social-button social-button--primary"
            disabled={props.pendingAction === "republish-public-records" || !identity}
            onClick={props.onRepublishPublicRecords}
          >
            Republish Records
          </button>
        </header>

        <div class="social-directory-summary">
          {identity ? (
            <FieldList>
              <FieldRow label="Handle" value={identity.handle} />
              <FieldRow label="PDS" value={identity.pdsEndpoint} />
              <FieldRow label="Profile" value={identity.profile?.displayName ?? "Published"} />
              <FieldRow label="Methods" value={identity.instance?.acceptedSocialMethods?.length ?? 0} />
            </FieldList>
          ) : (
            <EmptyState title="No social identity" body="Run GSV onboarding with builtin PDS setup enabled." />
          )}
        </div>

        <header class="social-subheader">
          <h2>Contact-published records</h2>
          <span>{contacts.length}</span>
        </header>
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
                <small>{contact.acceptedSocialMethods.length} advertised methods</small>
              </span>
              <StatusPill status={contact.acceptsContact ? "active" : "inactive"} />
            </button>
          )) : <p class="social-list-note">No contacts available.</p>}
        </div>
      </aside>

      <DirectoryDetail
        state={props.state}
        selectedContact={props.selectedContact}
        directory={props.contactDirectory}
      />
    </section>
  );
}

function DirectoryDetail(props: {
  state: SocialState | null;
  selectedContact: SocialContactSummary | null;
  directory: SocialContactDirectory | null;
}) {
  if (props.selectedContact) {
    return (
      <section class="social-detail-pane">
        <PaneHeader
          eyebrow="Contact Directory"
          title={props.selectedContact.displayName || props.selectedContact.handle}
          meta={<span>{props.selectedContact.handle}</span>}
        />
        <div class="social-detail-scroll">
          <PublishedDirectory directory={props.directory} />
        </div>
      </section>
    );
  }

  const identity = props.state?.identity ?? null;
  if (!identity) {
    return (
      <div class="social-detail-pane">
        <EmptyState title="Public identity unavailable" body="Published records will appear after social identity setup." />
      </div>
    );
  }

  return (
    <section class="social-detail-pane">
      <PaneHeader
        eyebrow="Public Identity"
        title={identity.profile?.displayName ?? identity.handle}
        meta={<span>{identity.handle}</span>}
      />
      <div class="social-detail-scroll">
        <section class="social-work-section">
          <h3>Profile</h3>
          <FieldList>
            <FieldRow label="Display" value={identity.profile?.displayName ?? "Not set"} />
            <FieldRow label="Description" value={identity.profile?.description ?? "Not set"} />
            <FieldRow label="Updated" value={formatShortDate(identity.profile?.updatedAt ?? identity.profile?.createdAt)} />
          </FieldList>
        </section>

        <section class="social-work-section">
          <h3>Instance</h3>
          <FieldList>
            <FieldRow label="Endpoint" value={identity.instance?.endpoint ?? identity.pdsEndpoint} />
            <FieldRow label="Protocol" value={identity.instance?.protocolVersion ?? "Unknown"} />
            <FieldRow label="Methods" value={identity.instance?.acceptedSocialMethods?.length ?? 0} />
          </FieldList>
        </section>

        <section class="social-work-section">
          <h3>Messaging</h3>
          <FieldList>
            <FieldRow label="Message send" value={identity.instance?.acceptedSocialMethods?.includes("social.message.send") ? "Accepted" : "Not advertised"} />
            <FieldRow label="Status updates" value={identity.instance?.acceptedSocialMethods?.includes("social.message.status.update") ? "Accepted" : "Not advertised"} />
          </FieldList>
        </section>
      </div>
    </section>
  );
}

function PublishedDirectory(props: { directory: SocialContactDirectory | null }) {
  const users = props.directory?.users ?? [];
  const contacts = props.directory?.contacts ?? [];
  const news = props.directory?.news ?? [];
  const packages = props.directory?.packages ?? [];
  const releases = props.directory?.packageReleases ?? [];
  const vouches = props.directory?.vouches ?? [];
  return (
    <>
      <section class="social-work-section">
        <div class="social-section-head">
          <h3>Users</h3>
          <span>{users.length}</span>
        </div>
        {users.length ? (
          <div class="social-record-table">
            {users.map((user) => (
              <div key={user.uri ?? `${user.handle}:${user.record.username}`}>
                <strong>{user.record.displayName || user.record.username}</strong>
                <span>{user.record.publicHandle || user.handle}</span>
                <small>{formatShortDate(user.record.updatedAt ?? user.record.createdAt)}</small>
              </div>
            ))}
          </div>
        ) : <p class="social-list-note">No user records published to this relationship.</p>}
      </section>

      <section class="social-work-section">
        <div class="social-section-head">
          <h3>Contacts</h3>
          <span>{contacts.length}</span>
        </div>
        {contacts.length ? (
          <div class="social-record-table">
            {contacts.map((item) => (
              <div key={item.uri ?? `${item.handle}:${item.record.subject.did}`}>
                <strong>{formatContactSubject(item.record)}</strong>
                <span>{item.record.subject.handle ?? item.record.subject.did}</span>
                <small>{formatShortDate(item.record.updatedAt ?? item.record.createdAt)}</small>
              </div>
            ))}
          </div>
        ) : <p class="social-list-note">No contact records published to this relationship.</p>}
      </section>

      <section class="social-work-section">
        <div class="social-section-head">
          <h3>News</h3>
          <span>{news.length}</span>
        </div>
        {news.length ? (
          <div class="social-record-table">
            {news.map((item) => (
              <div key={item.uri ?? `${item.handle}:${item.record.createdAt}`}>
                <strong>{item.record.text}</strong>
                <span>{item.handle}</span>
                <small>{formatShortDate(item.record.updatedAt ?? item.record.createdAt)}</small>
              </div>
            ))}
          </div>
        ) : <p class="social-list-note">No news published to this relationship.</p>}
      </section>

      <details class="social-work-section social-raw-details">
        <summary>Package records ({packages.length})</summary>
        {packages.length ? (
          <div class="social-record-table">
            {packages.map((item) => (
              <div key={item.uri}>
                <strong>{item.record.displayName || item.record.name}</strong>
                <span>{formatPackageSource(item.record)}</span>
                <small>{formatShortDate(item.record.updatedAt ?? item.record.createdAt)}</small>
              </div>
            ))}
          </div>
        ) : <p class="social-list-note">No package records published to this relationship.</p>}
      </details>

      <details class="social-work-section social-raw-details">
        <summary>Package releases ({releases.length})</summary>
        {releases.length ? (
          <div class="social-record-table">
            {releases.map((item) => (
              <div key={item.uri}>
                <strong>{formatPackageRelease(item.record)}</strong>
                <span>{item.record.description || item.record.package.uri}</span>
                <small>{formatShortDate(item.record.releasedAt ?? item.record.updatedAt ?? item.record.createdAt)}</small>
              </div>
            ))}
          </div>
        ) : <p class="social-list-note">No package releases published to this relationship.</p>}
      </details>

      <details class="social-work-section social-raw-details">
        <summary>Vouches ({vouches.length})</summary>
        {vouches.length ? (
          <div class="social-record-table">
            {vouches.map((item) => (
              <div key={item.uri}>
                <strong>{formatVouchSubject(item.record)}</strong>
                <span>{item.record.tags?.join(", ") || item.handle}</span>
                <small>{formatShortDate(item.record.updatedAt ?? item.record.createdAt)}</small>
              </div>
            ))}
          </div>
        ) : <p class="social-list-note">No vouches published to this relationship.</p>}
      </details>

      <details class="social-work-section social-raw-details">
        <summary>Directory payload</summary>
        <StructuredDetails value={props.directory} maxRows={8} />
      </details>
    </>
  );
}
