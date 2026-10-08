import { contactDisplayName } from "@humansandmachines/gsv/protocol";
import type { PeopleActivity as Activity } from "./usePeopleActivity";
import type { PeopleOpenRequest } from "./People";

export function PeopleActivity({ activity, liveContacts, onOpen }: {
  activity: Activity; liveContacts: readonly string[]; onOpen: (request?: PeopleOpenRequest) => void;
}) {
  const conversations = activity.conversations.filter((entry) => !liveContacts.includes(entry.contactId));
  if (!conversations.length && !activity.requests.length && !activity.error) return null;
  return <aside class="zen-people" aria-label="People waiting for you">
    <button class="zen-people-title" onClick={() => onOpen()}>people <span aria-hidden="true">↗</span></button>
    <div class="zen-people-items">
      {activity.requests.map((request) => <button key={request.id} class="zen-people-item" onClick={() => onOpen({ requestId: request.id })}>
        <span>{request.displayName}</span><small>{request.connection === "failed" ? "connection needs a retry" : "message request"}</small>
      </button>)}
      {conversations.map((entry) => {
        const contact = activity.contacts.find((item) => item.id === entry.contactId);
        const name = contact ? contactDisplayName(contact) : entry.conversation.title ?? "New message";
        return <button key={entry.contactId} class="zen-people-item" onClick={() => onOpen({ contactId: entry.contactId })}>
          <span>{name}</span><small>{entry.preview?.text || "unread conversation"}</small>
        </button>;
      })}
      {activity.hasMore && <button class="zen-people-item" onClick={() => onOpen()}>see all activity →</button>}
      {activity.error && <span class="zen-people-error" role="status">Couldn’t refresh People. <button onClick={() => onOpen()}>open People</button></span>}
    </div>
  </aside>;
}
