import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type {
  AddFriendArgs,
  CreateRequestArgs,
  RespondRequestArgs,
  SendMessageArgs,
  SocialBackend,
  SocialMessageItem,
  SocialPeerSummary,
  SocialRequestItem,
  SocialState,
  SocialThreadDetail,
  SocialView,
} from "./types";
import {
  REQUEST_KIND_OPTIONS as REQUEST_KINDS,
  SOCIAL_GRANT_OPTIONS,
} from "./types";

type AppProps = {
  backend: SocialBackend;
};

type PendingAction =
  | "load"
  | "add-friend"
  | "save-grants"
  | "remove-friend"
  | "send-message"
  | "create-request"
  | "respond-request";

type RequestFilter = "inbox" | "sent" | "all";
type ComposerMode = "message" | "request";

export function App({ backend }: AppProps) {
  const [state, setState] = useState<SocialState | null>(null);
  const [view, setView] = useState<SocialView>(readViewFromLocation());
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(readThreadFromLocation());
  const [selectedFriendHandle, setSelectedFriendHandle] = useState<string | null>(null);
  const [requestFilter, setRequestFilter] = useState<RequestFilter>("inbox");
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

  const refresh = useCallback(async (threadId: string | null) => {
    setPendingAction("load");
    try {
      const nextState = await backend.loadState({ threadId });
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
    void refresh(selectedThreadId);
  }, [refresh, selectedThreadId]);

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

  const runStateAction = useCallback(async (
    actionId: PendingAction,
    action: () => Promise<SocialState>,
  ) => {
    setPendingAction(actionId);
    try {
      const nextState = await action();
      setState(nextState);
      const nextThreadId = nextState.selectedThread?.thread?.threadId ?? selectedThreadId;
      setSelectedThreadId(nextThreadId ?? null);
      setError(null);
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setPendingAction(null);
    }
  }, [selectedThreadId]);

  function selectThread(threadId: string | null, nextView: SocialView = view): void {
    updateRoute({ view: nextView, threadId });
  }

  const content = state?.identity ? (
    <main class="social-main">
      {view === "friends" ? (
        <FriendsPanel
          friends={state.friends}
          selectedFriend={selectedFriend}
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
          onCreateRequest={(args) => runStateAction("create-request", () => backend.createRequest(args))}
        />
      ) : (
        <ThreadPanel
          identityHandle={state.identity.handle}
          detail={state.selectedThread}
          pendingAction={pendingAction}
          emptyTitle={view === "requests" ? "No request selected" : "No thread selected"}
          emptyBody={view === "requests" ? "Choose a request from the inbox." : "Choose a conversation or start one from Friends."}
          onSendMessage={(args) => runStateAction("send-message", () => backend.sendMessage(args))}
          onCreateRequest={(args) => runStateAction("create-request", () => backend.createRequest(args))}
          onRespondRequest={(args) => runStateAction("respond-request", () => backend.respondRequest(args))}
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
          requestFilter={requestFilter}
          selectedThreadId={selectedThreadId}
          pending={pendingAction === "load"}
          onSelectView={(nextView) => updateRoute({ view: nextView })}
          onSelectThread={(threadId) => selectThread(threadId, "threads")}
          onSelectRequest={(request) => selectThread(request.threadId ?? null, "requests")}
          onRequestFilterChange={setRequestFilter}
        />
        {content}
      </div>
    </div>
  );
}

function Sidebar(props: {
  state: SocialState | null;
  view: SocialView;
  requestFilter: RequestFilter;
  selectedThreadId: string | null;
  pending: boolean;
  onSelectView: (view: SocialView) => void;
  onSelectThread: (threadId: string) => void;
  onSelectRequest: (request: SocialRequestItem) => void;
  onRequestFilterChange: (filter: RequestFilter) => void;
}) {
  const { state, view } = props;
  const requests = state?.requests ?? [];
  const inboxRequests = requests.filter((request) => request.direction === "inbound" && isActiveRequest(request.status));
  const sentRequests = requests.filter((request) => request.direction === "outbound" && isActiveRequest(request.status));
  const visibleRequests = filterRequests(requests, props.requestFilter);
  const tabs: Array<[SocialView, string, number]> = [
    ["requests", "Inbox", inboxRequests.length],
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
            <Metric label="Inbox" value={inboxRequests.length} />
            <Metric label="Sent" value={sentRequests.length} />
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

      {view === "requests" ? (
        <div class="social-filter-row" aria-label="Request filters">
          {([
            ["inbox", "Inbound"],
            ["sent", "Sent"],
            ["all", "All"],
          ] as Array<[RequestFilter, string]>).map(([filter, label]) => (
            <button
              key={filter}
              type="button"
              class={`social-filter${props.requestFilter === filter ? " is-active" : ""}`}
              onClick={() => props.onRequestFilterChange(filter)}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      <div class="social-sidebar-list">
        {props.pending ? <div class="social-list-note">Loading...</div> : null}
        {view === "requests" ? (
          visibleRequests.length ? visibleRequests.map((request) => (
            <button
              key={request.requestId}
              type="button"
              class={`social-list-item${request.threadId === props.selectedThreadId ? " is-active" : ""}`}
              onClick={() => props.onSelectRequest(request)}
            >
              <StatusDot status={request.status} />
              <strong>{request.title}</strong>
              <span>{request.direction === "inbound" ? request.fromHandle : request.toHandle}</span>
              <small>{request.kind} · {request.status} · {formatShortDate(request.updatedAt)}</small>
            </button>
          )) : <div class="social-list-note">No matching requests.</div>
        ) : (
          state?.threads.length ? state.threads.map((thread) => (
            <button
              key={thread.threadId}
              type="button"
              class={`social-list-item${thread.threadId === props.selectedThreadId ? " is-active" : ""}`}
              onClick={() => props.onSelectThread(thread.threadId)}
            >
              <StatusDot status={thread.status} />
              <strong>{thread.topic || thread.peerHandle}</strong>
              <span>{thread.peerHandle}</span>
              <small>{thread.requestCount} requests · {formatShortDate(thread.updatedAt)}</small>
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
  onCreateRequest: (args: CreateRequestArgs) => void;
  onRespondRequest: (args: RespondRequestArgs) => void;
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
  const requests = props.detail?.requests ?? [];
  const activeRequests = requests.filter((request) => isActiveRequest(request.status));
  return (
    <section class="social-thread-pane">
      <header class="social-detail-head">
        <div>
          <p class="social-eyebrow">Conversation</p>
          <h2>{thread.topic || thread.peerHandle}</h2>
          <p>{thread.peerHandle}</p>
        </div>
        <div class="social-head-actions">
          <span class={`social-pill is-${thread.status}`}>{thread.status}</span>
          {activeRequests.length ? <span class="social-pill is-attention">{activeRequests.length} active</span> : null}
        </div>
      </header>

      <div class="social-thread-grid">
        <section class="social-message-stream" aria-label="Messages">
          {(props.detail?.messages ?? []).length ? props.detail!.messages.map((message) => (
            <MessageBubble key={message.messageId} message={message} identityHandle={props.identityHandle} />
          )) : <div class="social-list-note">No messages in this thread.</div>}
        </section>

        <aside class="social-request-rail">
          <header class="social-rail-head">
            <h3>Work</h3>
            <span>{requests.length}</span>
          </header>
          {requests.length ? requests.map((request) => (
            <RequestCard
              key={request.requestId}
              identityHandle={props.identityHandle}
              request={request}
              pendingAction={props.pendingAction}
              onRespondRequest={props.onRespondRequest}
            />
          )) : <div class="social-list-note">No requests in this conversation.</div>}
        </aside>
      </div>

      <InteractionComposer
        peerHandle={thread.peerHandle}
        threadId={thread.threadId}
        sendPending={props.pendingAction === "send-message"}
        requestPending={props.pendingAction === "create-request"}
        onSendMessage={props.onSendMessage}
        onCreateRequest={props.onCreateRequest}
      />
    </section>
  );
}

function MessageBubble(props: {
  message: SocialMessageItem;
  identityHandle: string;
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
    </article>
  );
}

function RequestCard(props: {
  identityHandle: string;
  request: SocialRequestItem;
  pendingAction: PendingAction | null;
  onRespondRequest: (args: RespondRequestArgs) => void;
}) {
  const canRespond = props.request.direction === "inbound" &&
    props.request.toHandle === props.identityHandle &&
    props.request.status !== "completed" &&
    props.request.status !== "declined" &&
    props.request.status !== "expired";
  return (
    <article class={`social-request-card is-${props.request.direction}`}>
      <header>
        <div>
          <p class="social-eyebrow">{props.request.direction === "inbound" ? "Inbound request" : "Sent request"}</p>
          <h3>{props.request.title}</h3>
        </div>
        <span class={`social-pill is-${props.request.status}`}>{props.request.status}</span>
      </header>
      <div class="social-request-meta">
        <span>{props.request.kind}</span>
        <span>{props.request.direction === "inbound" ? props.request.fromHandle : props.request.toHandle}</span>
        <span>{formatShortDate(props.request.updatedAt)}</span>
      </div>
      <StructuredDetails value={props.request.body} />
      {canRespond ? (
        <RequestResponseForm
          request={props.request}
          pending={props.pendingAction === "respond-request"}
          onRespondRequest={props.onRespondRequest}
        />
      ) : null}
    </article>
  );
}

function FriendsPanel(props: {
  friends: SocialPeerSummary[];
  selectedFriend: SocialPeerSummary | null;
  pendingAction: PendingAction | null;
  onSelectFriend: (handle: string) => void;
  onAddFriend: (args: AddFriendArgs) => void;
  onSaveGrants: (args: { handle: string; grants: AddFriendArgs["grants"] }) => void;
  onRemoveFriend: (handle: string) => void;
  onSendMessage: (args: SendMessageArgs) => void;
  onCreateRequest: (args: CreateRequestArgs) => void;
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
              <StatusDot status={friend.acceptsRequests ? "active" : "inactive"} />
              <strong>{friend.displayName || friend.handle}</strong>
              <span>{friend.handle}</span>
              <small>{friend.grants.length} grants · {formatShortDate(friend.updatedAt)}</small>
            </button>
          )) : <div class="social-list-note">No friends.</div>}
        </div>
      </div>

      <FriendDetail
        friend={props.selectedFriend}
        pendingAction={props.pendingAction}
        onSaveGrants={props.onSaveGrants}
        onRemoveFriend={props.onRemoveFriend}
        onSendMessage={props.onSendMessage}
        onCreateRequest={props.onCreateRequest}
      />
    </section>
  );
}

function FriendDetail(props: {
  friend: SocialPeerSummary | null;
  pendingAction: PendingAction | null;
  onSaveGrants: (args: { handle: string; grants: AddFriendArgs["grants"] }) => void;
  onRemoveFriend: (handle: string) => void;
  onSendMessage: (args: SendMessageArgs) => void;
  onCreateRequest: (args: CreateRequestArgs) => void;
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

      <section class="social-detail-section">
        <h3>Start</h3>
        <InteractionComposer
          peerHandle={props.friend.handle}
          sendPending={props.pendingAction === "send-message"}
          requestPending={props.pendingAction === "create-request"}
          onSendMessage={props.onSendMessage}
          onCreateRequest={props.onCreateRequest}
        />
      </section>
    </section>
  );
}

function AddFriendForm(props: {
  pending: boolean;
  onAddFriend: (args: AddFriendArgs) => void;
}) {
  const [handle, setHandle] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(SOCIAL_GRANT_OPTIONS.map((option) => option.operation)));
  return (
    <form
      class="social-add-friend"
      onSubmit={(event) => {
        event.preventDefault();
        props.onAddFriend({
          handle,
          grants: Array.from(selected).map((operation) => ({
            operation: operation as AddFriendArgs["grants"][number]["operation"],
          })),
        });
        setHandle("");
      }}
    >
      <label>
        <span>Friend handle</span>
        <input value={handle} onInput={(event) => setHandle(event.currentTarget.value)} placeholder="alice.example" />
      </label>
      <GrantChecklist selected={selected} onChange={setSelected} compact />
      <button class="social-button social-button--primary" type="submit" disabled={props.pending || !handle.trim()}>
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

function InteractionComposer(props: {
  peerHandle: string;
  threadId?: string;
  sendPending: boolean;
  requestPending: boolean;
  onSendMessage: (args: SendMessageArgs) => void;
  onCreateRequest: (args: CreateRequestArgs) => void;
}) {
  const [mode, setMode] = useState<ComposerMode>("message");
  return (
    <section class="social-composer">
      <div class="social-mode-tabs" aria-label="Interaction type">
        {([
          ["message", "Message"],
          ["request", "Request"],
        ] as Array<[ComposerMode, string]>).map(([nextMode, label]) => (
          <button
            key={nextMode}
            type="button"
            class={mode === nextMode ? "is-active" : ""}
            onClick={() => setMode(nextMode)}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "message" ? (
        <MessageForm
          peerHandle={props.peerHandle}
          threadId={props.threadId}
          pending={props.sendPending}
          onSendMessage={props.onSendMessage}
        />
      ) : (
        <RequestForm
          peerHandle={props.peerHandle}
          threadId={props.threadId}
          pending={props.requestPending}
          onCreateRequest={props.onCreateRequest}
        />
      )}
    </section>
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

function RequestForm(props: {
  peerHandle: string;
  threadId?: string;
  pending: boolean;
  onCreateRequest: (args: CreateRequestArgs) => void;
}) {
  const [kind, setKind] = useState<(typeof REQUEST_KINDS)[number]["kind"]>("question");
  const [title, setTitle] = useState("");
  const [bodyText, setBodyText] = useState("");
  return (
    <form
      class="social-compose"
      onSubmit={(event) => {
        event.preventDefault();
        const args: CreateRequestArgs = {
          toHandle: props.peerHandle,
          kind,
          title,
          bodyText,
        };
        if (props.threadId) {
          args.threadId = props.threadId;
        }
        props.onCreateRequest(args);
        setTitle("");
        setBodyText("");
      }}
    >
      <div class="social-inline-fields">
        <label>
          <span>Kind</span>
          <select value={kind} onChange={(event) => setKind(event.currentTarget.value as typeof kind)}>
            {REQUEST_KINDS.map((option) => (
              <option key={option.kind} value={option.kind}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Title</span>
          <input value={title} onInput={(event) => setTitle(event.currentTarget.value)} />
        </label>
      </div>
      <label>
        <span>Details</span>
        <textarea value={bodyText} onInput={(event) => setBodyText(event.currentTarget.value)} rows={3} />
      </label>
      <button class="social-button social-button--primary" type="submit" disabled={props.pending || !title.trim()}>
        Create
      </button>
    </form>
  );
}

function RequestResponseForm(props: {
  request: SocialRequestItem;
  pending: boolean;
  onRespondRequest: (args: RespondRequestArgs) => void;
}) {
  const [status, setStatus] = useState<RespondRequestArgs["status"]>("agent-replied");
  const [text, setText] = useState("");
  return (
    <form
      class="social-response-form"
      onSubmit={(event) => {
        event.preventDefault();
        props.onRespondRequest({
          requestId: props.request.requestId,
          status,
          text,
          threadId: props.request.threadId,
        });
        setText("");
      }}
    >
      <select value={status} onChange={(event) => setStatus(event.currentTarget.value as typeof status)}>
        <option value="agent-replied">Agent replied</option>
        <option value="needs-human">Needs human</option>
        <option value="accepted">Accepted</option>
        <option value="declined">Declined</option>
        <option value="completed">Completed</option>
      </select>
      <textarea value={text} onInput={(event) => setText(event.currentTarget.value)} rows={2} />
      <button class="social-button social-button--primary" type="submit" disabled={props.pending}>
        Respond
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

function filterRequests(requests: SocialRequestItem[], filter: RequestFilter): SocialRequestItem[] {
  if (filter === "inbox") {
    return requests.filter((request) => request.direction === "inbound" && isActiveRequest(request.status));
  }
  if (filter === "sent") {
    return requests.filter((request) => request.direction === "outbound");
  }
  return requests;
}

function readViewFromLocation(): SocialView {
  const value = new URL(window.location.href).searchParams.get("view");
  return value === "requests" || value === "friends" ? value : "threads";
}

function readThreadFromLocation(): string | null {
  return new URL(window.location.href).searchParams.get("thread")?.trim() || null;
}

function isActiveRequest(status: SocialRequestItem["status"]): boolean {
  return status === "pending" || status === "agent-replied" || status === "needs-human" || status === "accepted";
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
