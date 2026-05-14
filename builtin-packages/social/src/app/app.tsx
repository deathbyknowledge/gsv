import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type {
  AddFriendArgs,
  SendMessageArgs,
  SocialBackend,
  SocialFriendDirectory,
  SocialMessageItem,
  SocialMessageStatusItem,
  SocialPeerSummary,
  SocialState,
  SocialThreadDetail,
  SocialView,
  UpdateMessageStatusArgs,
} from "./types";
import { SOCIAL_GRANT_OPTIONS } from "./types";

type AppProps = {
  backend: SocialBackend;
};

type PendingAction =
  | "load"
  | "add-friend"
  | "save-grants"
  | "remove-friend"
  | "send-message"
  | "update-status";

type InboxFilter = "active" | "needs-human" | "all";

const ACTIVE_STATUS_STATES = new Set<SocialMessageStatusItem["state"]>([
  "received",
  "triaged",
  "in_progress",
  "needs_human",
]);

const STATUS_OPTIONS: Array<{ state: UpdateMessageStatusArgs["state"]; label: string }> = [
  { state: "triaged", label: "Triaged" },
  { state: "in_progress", label: "In progress" },
  { state: "needs_human", label: "Needs human" },
  { state: "completed", label: "Completed" },
  { state: "declined", label: "Declined" },
  { state: "failed", label: "Failed" },
];

export function App({ backend }: AppProps) {
  const [state, setState] = useState<SocialState | null>(null);
  const [view, setView] = useState<SocialView>(readViewFromLocation());
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(readThreadFromLocation());
  const [selectedFriendHandle, setSelectedFriendHandle] = useState<string | null>(null);
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>("active");
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const updateRoute = useCallback((next: { view?: SocialView; threadId?: string | null }) => {
    const nextView = next.view ?? view;
    const nextThreadId = next.threadId === undefined ? selectedThreadId : next.threadId;
    const url = new URL(window.location.href);
    url.searchParams.set("view", nextView);
    if (nextThreadId) {
      url.searchParams.set("thread", nextThreadId);
    } else {
      url.searchParams.delete("thread");
    }
    window.history.pushState({}, "", url);
    setView(nextView);
    setSelectedThreadId(nextThreadId ?? null);
  }, [selectedThreadId, view]);

  const refresh = useCallback(async (threadId: string | null, friendHandle: string | null) => {
    setPendingAction("load");
    try {
      const nextState = await backend.loadState({ threadId, friendHandle });
      setState(nextState);
      if (nextState.selectedThread?.thread?.threadId && nextState.selectedThread.thread.threadId !== selectedThreadId) {
        setSelectedThreadId(nextState.selectedThread.thread.threadId);
      }
      setError(null);
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setPendingAction(null);
    }
  }, [backend, selectedThreadId]);

  useEffect(() => {
    void refresh(selectedThreadId, selectedFriendHandle);
  }, [refresh, selectedFriendHandle, selectedThreadId]);

  useEffect(() => {
    const onPopState = () => {
      setView(readViewFromLocation());
      setSelectedThreadId(readThreadFromLocation());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const selectedFriend = useMemo(() => {
    if (!state?.friends.length) {
      return null;
    }
    return state.friends.find((friend) => friend.handle === selectedFriendHandle) ?? state.friends[0] ?? null;
  }, [selectedFriendHandle, state?.friends]);

  useEffect(() => {
    if (!selectedFriendHandle && state?.friends[0]) {
      setSelectedFriendHandle(state.friends[0].handle);
    }
  }, [selectedFriendHandle, state?.friends]);

  const runStateAction = useCallback(async (
    actionId: PendingAction,
    action: () => Promise<SocialState>,
  ) => {
    setPendingAction(actionId);
    try {
      const nextState = await action();
      const nextThreadId = nextState.selectedThread?.thread?.threadId ?? selectedThreadId;
      const nextFriendHandle = selectedFriendHandle && nextState.friends.some((friend) => friend.handle === selectedFriendHandle)
        ? selectedFriendHandle
        : null;
      const hydratedState = nextFriendHandle
        ? await backend.loadState({ threadId: nextThreadId, friendHandle: nextFriendHandle })
        : nextState;
      setState(hydratedState);
      setSelectedThreadId(nextThreadId ?? null);
      setError(null);
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setPendingAction(null);
    }
  }, [backend, selectedFriendHandle, selectedThreadId]);

  function selectThread(threadId: string | null, nextView: SocialView = view): void {
    updateRoute({ view: nextView, threadId });
  }

  const content = state?.identity ? (
    <main class="social-main">
      {view === "friends" ? (
        <FriendsPanel
          friends={state.friends}
          selectedFriend={selectedFriend}
          friendDirectory={state.friendDirectory?.handle === selectedFriend?.handle ? state.friendDirectory : null}
          pendingAction={pendingAction}
          onSelectFriend={setSelectedFriendHandle}
          onAddFriend={(args) => runStateAction("add-friend", () => backend.addFriend(args))}
          onSaveGrants={(args) => runStateAction("save-grants", () => backend.setFriendGrants({
            ...args,
            threadId: selectedThreadId,
          }))}
          onRemoveFriend={(handle) => runStateAction("remove-friend", () => backend.removeFriend({
            handle,
            threadId: selectedThreadId,
          }))}
          onSendMessage={(args) => runStateAction("send-message", () => backend.sendMessage(args))}
        />
      ) : (
        <ThreadPanel
          identityHandle={state.identity.handle}
          detail={state.selectedThread}
          pendingAction={pendingAction}
          emptyTitle={view === "inbox" ? "No inbox item selected" : "No thread selected"}
          emptyBody={view === "inbox" ? "Choose an active message from the inbox." : "Choose a conversation or start one from Friends."}
          onSendMessage={(args) => runStateAction("send-message", () => backend.sendMessage(args))}
          onUpdateStatus={(args) => runStateAction("update-status", () => backend.updateMessageStatus(args))}
        />
      )}
    </main>
  ) : (
    <main class="social-main">
      <section class="social-empty-state">
        <h2>No social identity</h2>
        <p>Run GSV onboarding with builtin PDS setup enabled.</p>
      </section>
    </main>
  );

  return (
    <div class="social-app">
      {error ? <div class="social-error-banner">{error}</div> : null}
      <div class="social-layout">
        <Sidebar
          state={state}
          view={view}
          inboxFilter={inboxFilter}
          selectedThreadId={selectedThreadId}
          pending={pendingAction === "load"}
          onSelectView={(nextView) => updateRoute({ view: nextView })}
          onSelectThread={(threadId) => selectThread(threadId, "threads")}
          onSelectStatus={(status) => selectThread(status.threadId, "inbox")}
          onInboxFilterChange={setInboxFilter}
        />
        {content}
      </div>
    </div>
  );
}

function Sidebar(props: {
  state: SocialState | null;
  view: SocialView;
  inboxFilter: InboxFilter;
  selectedThreadId: string | null;
  pending: boolean;
  onSelectView: (view: SocialView) => void;
  onSelectThread: (threadId: string) => void;
  onSelectStatus: (status: SocialMessageStatusItem) => void;
  onInboxFilterChange: (filter: InboxFilter) => void;
}) {
  const { state, view } = props;
  const statuses = state?.statuses ?? [];
  const activeInbox = statuses.filter((status) => status.direction === "inbound" && isActiveStatus(status.state));
  const needsHuman = activeInbox.filter((status) => status.state === "needs_human");
  const visibleStatuses = filterStatuses(statuses, props.inboxFilter);
  const tabs: Array<[SocialView, string, number]> = [
    ["inbox", "Inbox", activeInbox.length],
    ["threads", "Threads", state?.threads.length ?? 0],
    ["friends", "Friends", state?.friends.length ?? 0],
  ];

  return (
    <aside class="social-sidebar">
      <header class="social-sidebar-head">
        <p class="social-eyebrow">GSV social</p>
        <h1>{state?.identity?.handle ?? "Not linked"}</h1>
        {state?.identity ? (
          <div class="social-metric-strip" aria-label="Social overview">
            <Metric label="Inbox" value={activeInbox.length} />
            <Metric label="Human" value={needsHuman.length} />
            <Metric label="Friends" value={state.friends.length} />
          </div>
        ) : null}
      </header>

      <nav class="social-tabs" aria-label="Social sections">
        {tabs.map(([tab, label, count]) => (
          <button
            key={tab}
            type="button"
            class={`social-tab${view === tab ? " is-active" : ""}`}
            onClick={() => props.onSelectView(tab)}
          >
            <span>{label}</span>
            <strong>{count}</strong>
          </button>
        ))}
      </nav>

      {view === "inbox" ? (
        <div class="social-filter-row" aria-label="Inbox filters">
          {([
            ["active", "Active"],
            ["needs-human", "Human"],
            ["all", "All"],
          ] as Array<[InboxFilter, string]>).map(([filter, label]) => (
            <button
              key={filter}
              type="button"
              class={`social-filter${props.inboxFilter === filter ? " is-active" : ""}`}
              onClick={() => props.onInboxFilterChange(filter)}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      <div class="social-sidebar-list">
        {props.pending ? <div class="social-list-note">Loading...</div> : null}
        {view === "inbox" ? (
          visibleStatuses.length ? visibleStatuses.map((status) => (
            <button
              key={status.messageId}
              type="button"
              class={`social-list-item${status.threadId === props.selectedThreadId ? " is-active" : ""}`}
              onClick={() => props.onSelectStatus(status)}
            >
              <StatusDot status={status.state} />
              <strong>{status.summary || "Message"}</strong>
              <span>{status.direction === "inbound" ? status.fromHandle : status.toHandle}</span>
              <small>{status.state} · {formatShortDate(status.updatedAt)}</small>
            </button>
          )) : <div class="social-list-note">No matching inbox items.</div>
        ) : (
          state?.threads.length ? state.threads.map((thread) => (
            <button
              key={thread.threadId}
              type="button"
              class={`social-list-item${thread.threadId === props.selectedThreadId ? " is-active" : ""}`}
              onClick={() => props.onSelectThread(thread.threadId)}
            >
              <StatusDot status={thread.status} />
              <strong>{thread.peerHandle}</strong>
              <span>{thread.peerHandle}</span>
              <small>{thread.statusCount} tracked · {formatShortDate(thread.updatedAt)}</small>
            </button>
          )) : <div class="social-list-note">No threads.</div>
        )}
      </div>
    </aside>
  );
}

function Metric(props: { label: string; value: number }) {
  return (
    <div class="social-metric">
      <strong>{props.value}</strong>
      <span>{props.label}</span>
    </div>
  );
}

function ThreadPanel(props: {
  identityHandle: string;
  detail: SocialThreadDetail | null;
  pendingAction: PendingAction | null;
  emptyTitle: string;
  emptyBody: string;
  onSendMessage: (args: SendMessageArgs) => void;
  onUpdateStatus: (args: UpdateMessageStatusArgs) => void;
}) {
  const thread = props.detail?.thread ?? null;
  if (!thread) {
    return (
      <section class="social-empty-state">
        <h2>{props.emptyTitle}</h2>
        <p>{props.emptyBody}</p>
      </section>
    );
  }
  const statuses = props.detail?.statuses ?? [];
  const statusByMessage = new Map(statuses.map((status) => [status.messageId, status]));
  const activeStatuses = statuses.filter((status) => status.direction === "inbound" && isActiveStatus(status.state));
  return (
    <section class="social-thread-pane">
      <header class="social-detail-head">
        <div>
          <p class="social-eyebrow">Conversation</p>
          <h2>{thread.peerHandle}</h2>
          <p>{thread.peerHandle}</p>
        </div>
        <div class="social-head-actions">
          <span class={`social-pill is-${thread.status}`}>{thread.status}</span>
          {activeStatuses.length ? <span class="social-pill is-attention">{activeStatuses.length} active</span> : null}
        </div>
      </header>

      <div class="social-thread-grid">
        <section class="social-message-stream" aria-label="Messages">
          {(props.detail?.messages ?? []).length ? props.detail!.messages.map((message) => (
            <MessageBubble
              key={message.messageId}
              message={message}
              identityHandle={props.identityHandle}
              status={statusByMessage.get(message.messageId)}
            />
          )) : <div class="social-list-note">No messages in this thread.</div>}
        </section>

        <aside class="social-status-rail">
          <header class="social-rail-head">
            <h3>Status</h3>
            <span>{statuses.length}</span>
          </header>
          {statuses.length ? statuses.map((status) => (
            <StatusCard
              key={status.messageId}
              identityHandle={props.identityHandle}
              status={status}
              pending={props.pendingAction === "update-status"}
              onUpdateStatus={props.onUpdateStatus}
            />
          )) : <div class="social-list-note">No tracked messages in this conversation.</div>}
        </aside>
      </div>

      <MessageForm
        peerHandle={thread.peerHandle}
        threadId={thread.threadId}
        pending={props.pendingAction === "send-message"}
        onSendMessage={props.onSendMessage}
      />
    </section>
  );
}

function MessageBubble(props: {
  message: SocialMessageItem;
  identityHandle: string;
  status?: SocialMessageStatusItem;
}) {
  const fromMe = props.message.fromHandle === props.identityHandle;
  return (
    <article class={`social-message is-${fromMe ? "mine" : "theirs"}`}>
      <header>
        <strong>{fromMe ? "You" : props.message.fromHandle}</strong>
        <span>{props.message.deliveryStatus} · {formatShortDate(props.message.createdAt)}</span>
      </header>
      {props.message.text ? <p>{props.message.text}</p> : null}
      <StructuredDetails value={props.message.body} />
      {props.status ? (
        <footer class="social-message-status">
          <span class={`social-pill is-${props.status.state}`}>{props.status.state}</span>
          {props.status.summary ? <span>{props.status.summary}</span> : null}
        </footer>
      ) : null}
    </article>
  );
}

function StatusCard(props: {
  identityHandle: string;
  status: SocialMessageStatusItem;
  pending: boolean;
  onUpdateStatus: (args: UpdateMessageStatusArgs) => void;
}) {
  const peer = props.status.direction === "inbound" ? props.status.fromHandle : props.status.toHandle;
  const canUpdate = props.status.direction === "inbound" && props.status.toHandle === props.identityHandle;
  return (
    <article class={`social-status-card is-${props.status.direction}`}>
      <header>
        <div>
          <p class="social-eyebrow">{props.status.direction === "inbound" ? "Inbound message" : "Remote status"}</p>
          <h3>{props.status.summary || props.status.messageId}</h3>
        </div>
        <span class={`social-pill is-${props.status.state}`}>{props.status.state}</span>
      </header>
      <div class="social-status-meta">
        <span>{peer}</span>
        <span>{formatShortDate(props.status.updatedAt)}</span>
      </div>
      {props.status.needsHumanReason ? <p class="social-structured-text">{props.status.needsHumanReason}</p> : null}
      <StructuredDetails value={props.status.body} />
      {canUpdate ? (
        <StatusUpdateForm
          status={props.status}
          pending={props.pending}
          onUpdateStatus={props.onUpdateStatus}
        />
      ) : null}
    </article>
  );
}

function FriendsPanel(props: {
  friends: SocialPeerSummary[];
  selectedFriend: SocialPeerSummary | null;
  friendDirectory: SocialFriendDirectory | null;
  pendingAction: PendingAction | null;
  onSelectFriend: (handle: string) => void;
  onAddFriend: (args: AddFriendArgs) => void;
  onSaveGrants: (args: { handle: string; grants: AddFriendArgs["grants"] }) => void;
  onRemoveFriend: (handle: string) => void;
  onSendMessage: (args: SendMessageArgs) => void;
}) {
  return (
    <section class="social-friends-pane">
      <div class="social-friends-list">
        <AddFriendForm
          pending={props.pendingAction === "add-friend"}
          onAddFriend={props.onAddFriend}
        />
        <div class="social-friend-buttons">
          {props.friends.length ? props.friends.map((friend) => (
            <button
              key={friend.handle}
              type="button"
              class={`social-list-item${props.selectedFriend?.handle === friend.handle ? " is-active" : ""}`}
              onClick={() => props.onSelectFriend(friend.handle)}
            >
              <StatusDot status={friend.acceptsMessages ? "active" : "inactive"} />
              <strong>{friend.displayName || friend.handle}</strong>
              <span>{friend.handle}</span>
              <span>{friend.note}</span>
              <small>{friend.grants.length} grants · {formatShortDate(friend.updatedAt)}</small>
            </button>
          )) : <div class="social-list-note">No friends.</div>}
        </div>
      </div>

      <FriendDetail
        friend={props.selectedFriend}
        directory={props.friendDirectory}
        pendingAction={props.pendingAction}
        onSaveGrants={props.onSaveGrants}
        onRemoveFriend={props.onRemoveFriend}
        onSendMessage={props.onSendMessage}
      />
    </section>
  );
}

function FriendDetail(props: {
  friend: SocialPeerSummary | null;
  directory: SocialFriendDirectory | null;
  pendingAction: PendingAction | null;
  onSaveGrants: (args: { handle: string; grants: AddFriendArgs["grants"] }) => void;
  onRemoveFriend: (handle: string) => void;
  onSendMessage: (args: SendMessageArgs) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    setSelected(new Set(props.friend?.grants.map((grant) => grant.operation) ?? []));
  }, [props.friend?.handle, props.friend?.grants]);

  if (!props.friend) {
    return (
      <section class="social-empty-state">
        <h2>No friend selected</h2>
      </section>
    );
  }

  return (
    <section class="social-friend-detail">
      <header class="social-detail-head">
        <div>
          <p class="social-eyebrow">Friend</p>
          <h2>{props.friend.displayName || props.friend.handle}</h2>
          <p>{props.friend.agentDisplayName || props.friend.handle}</p>
          <p>{props.friend.note}</p>
        </div>
        <button
          type="button"
          class="social-button social-button--danger"
          disabled={props.pendingAction === "remove-friend"}
          onClick={() => props.onRemoveFriend(props.friend!.handle)}
        >
          Remove
        </button>
      </header>

      <section class="social-detail-section">
        <div class="social-section-head">
          <h3>Trust</h3>
          <button
            type="button"
            class="social-button social-button--primary"
            disabled={props.pendingAction === "save-grants"}
            onClick={() => props.onSaveGrants({
              handle: props.friend!.handle,
              grants: Array.from(selected).map((operation) => ({
                operation: operation as AddFriendArgs["grants"][number]["operation"],
              })),
            })}
          >
            Save
          </button>
        </div>
        <GrantChecklist selected={selected} onChange={setSelected} />
      </section>

      <section class="social-detail-section">
        <h3>Available</h3>
        <div class="social-method-grid">
          {SOCIAL_GRANT_OPTIONS.map((option) => {
            const advertised = props.friend!.acceptedSocialMethods.includes(option.operation);
            return (
              <span key={option.operation} class={`social-method${advertised ? " is-on" : ""}`}>
                {option.label}
              </span>
            );
          })}
        </div>
      </section>

      <FriendDirectory directory={props.directory} />

      <section class="social-detail-section">
        <h3>Start</h3>
        <MessageForm
          peerHandle={props.friend.handle}
          pending={props.pendingAction === "send-message"}
          onSendMessage={props.onSendMessage}
        />
      </section>
    </section>
  );
}

function FriendDirectory(props: { directory: SocialFriendDirectory | null }) {
  const users = props.directory?.users ?? [];
  const packageLikes = props.directory?.packageLikes ?? [];
  return (
    <section class="social-detail-section">
      <div class="social-section-head">
        <h3>Directory</h3>
        <span>{users.length} users · {packageLikes.length} likes</span>
      </div>
      <div class="social-directory-grid">
        <section>
          <h4>Users</h4>
          {users.length ? (
            <div class="social-detail-list">
              {users.map((user) => (
                <div key={user.uri ?? `${user.handle}:${user.record.username}`}>
                  <dt>{user.record.username}</dt>
                  <dd>{user.record.displayName || user.record.publicHandle || "Published user"}</dd>
                </div>
              ))}
            </div>
          ) : <p class="social-list-note">No published users.</p>}
        </section>
        <section>
          <h4>Package likes</h4>
          {packageLikes.length ? (
            <div class="social-detail-list">
              {packageLikes.map((like) => (
                <div key={like.uri}>
                  <dt>{like.record.subject.name}</dt>
                  <dd>{formatPackageSubject(like.record)}{like.record.note ? ` - ${like.record.note}` : ""}</dd>
                </div>
              ))}
            </div>
          ) : <p class="social-list-note">No published package likes.</p>}
        </section>
      </div>
    </section>
  );
}

function AddFriendForm(props: {
  pending: boolean;
  onAddFriend: (args: AddFriendArgs) => void;
}) {
  const [handle, setHandle] = useState("");
  const [note, setNote] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(SOCIAL_GRANT_OPTIONS.map((option) => option.operation)));
  return (
    <form
      class="social-add-friend"
      onSubmit={(event) => {
        event.preventDefault();
        props.onAddFriend({
          handle,
          note,
          grants: Array.from(selected).map((operation) => ({
            operation: operation as AddFriendArgs["grants"][number]["operation"],
          })),
        });
        setHandle("");
        setNote("");
      }}
    >
      <label>
        <span>Friend handle</span>
        <input value={handle} onInput={(event) => setHandle(event.currentTarget.value)} placeholder="alice.example" />
      </label>
      <label>
        <span>Relationship note</span>
        <input value={note} onInput={(event) => setNote(event.currentTarget.value)} placeholder="Alice's household GSV" />
      </label>
      <GrantChecklist selected={selected} onChange={setSelected} compact />
      <button class="social-button social-button--primary" type="submit" disabled={props.pending || !handle.trim() || !note.trim()}>
        Add
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

function MessageForm(props: {
  peerHandle: string;
  threadId?: string;
  pending: boolean;
  onSendMessage: (args: SendMessageArgs) => void;
}) {
  const [text, setText] = useState("");
  return (
    <form
      class="social-compose"
      onSubmit={(event) => {
        event.preventDefault();
        const args: SendMessageArgs = {
          toHandle: props.peerHandle,
          text,
        };
        if (props.threadId) {
          args.threadId = props.threadId;
        }
        props.onSendMessage(args);
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

function StatusUpdateForm(props: {
  status: SocialMessageStatusItem;
  pending: boolean;
  onUpdateStatus: (args: UpdateMessageStatusArgs) => void;
}) {
  const [state, setState] = useState<UpdateMessageStatusArgs["state"]>("completed");
  const [summary, setSummary] = useState("");
  const [reason, setReason] = useState("");
  return (
    <form
      class="social-response-form"
      onSubmit={(event) => {
        event.preventDefault();
        props.onUpdateStatus({
          messageId: props.status.messageId,
          threadId: props.status.threadId,
          state,
          summary,
          needsHumanReason: state === "needs_human" ? reason : undefined,
        });
        setSummary("");
        setReason("");
      }}
    >
      <select value={state} onChange={(event) => setState(event.currentTarget.value as typeof state)}>
        {STATUS_OPTIONS.map((option) => (
          <option key={option.state} value={option.state}>{option.label}</option>
        ))}
      </select>
      <textarea
        value={summary}
        onInput={(event) => setSummary(event.currentTarget.value)}
        rows={2}
        placeholder="Summary"
      />
      {state === "needs_human" ? (
        <input
          value={reason}
          onInput={(event) => setReason(event.currentTarget.value)}
          placeholder="Reason"
        />
      ) : null}
      <button class="social-button social-button--primary" type="submit" disabled={props.pending}>
        Update
      </button>
    </form>
  );
}

function StructuredDetails(props: { value: unknown }) {
  if (props.value === undefined) {
    return null;
  }
  if (typeof props.value === "string") {
    return <p class="social-structured-text">{props.value}</p>;
  }
  const entries = plainObjectEntries(props.value);
  if (entries.length === 0) {
    return (
      <details class="social-raw-details">
        <summary>Details</summary>
        <pre>{formatJson(props.value)}</pre>
      </details>
    );
  }
  return (
    <div class="social-detail-list">
      {entries.slice(0, 6).map(([key, value]) => (
        <div key={key}>
          <dt>{humanizeKey(key)}</dt>
          <dd>{formatStructuredValue(value)}</dd>
        </div>
      ))}
      {entries.length > 6 ? (
        <details class="social-raw-details">
          <summary>{entries.length - 6} more</summary>
          <pre>{formatJson(props.value)}</pre>
        </details>
      ) : null}
    </div>
  );
}

function StatusDot(props: { status: string }) {
  return <span class={`social-status-dot is-${props.status}`} />;
}

function filterStatuses(statuses: SocialMessageStatusItem[], filter: InboxFilter): SocialMessageStatusItem[] {
  const inbound = statuses.filter((status) => status.direction === "inbound");
  if (filter === "active") {
    return inbound.filter((status) => isActiveStatus(status.state));
  }
  if (filter === "needs-human") {
    return inbound.filter((status) => status.state === "needs_human");
  }
  return inbound;
}

function readViewFromLocation(): SocialView {
  const value = new URL(window.location.href).searchParams.get("view");
  if (value === "friends" || value === "threads") {
    return value;
  }
  return "inbox";
}

function readThreadFromLocation(): string | null {
  return new URL(window.location.href).searchParams.get("thread")?.trim() || null;
}

function isActiveStatus(state: SocialMessageStatusItem["state"]): boolean {
  return ACTIVE_STATUS_STATES.has(state);
}

function formatShortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatPackageSubject(record: SocialFriendDirectory["packageLikes"][number]["record"]): string {
  const subject = record.subject;
  return subject.repo ?? subject.uri ?? subject.subdir ?? subject.ref ?? "GSV package";
}

function plainObjectEntries(value: unknown): Array<[string, unknown]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>);
}

function formatStructuredValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `${value.length} items`;
  }
  if (typeof value === "object") {
    return "object";
  }
  return "";
}

function humanizeKey(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
