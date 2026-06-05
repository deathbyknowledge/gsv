import type { ProcessEntry, Profile, ThreadContext } from "../../types";
import { ChevronDownIcon, PlusIcon, ThreadsIcon } from "../../icons";
import { displayThreadLabel, formatRelativeTime } from "../../view-helpers";
import { AgentAvatar } from "./AgentAvatar";

export function ChatNavigator(props: {
  active: ThreadContext | null;
  threads: ProcessEntry[];
  threadsLoading: boolean;
  threadsError: string;
  profiles: Profile[];
  homeLabel: string;
  draftProfileId: string;
  onDraftProfileChange(profileId: string): void;
  onHome(): void;
  onNew(): void;
  onOpenThread(pid: string): void;
}) {
  return (
    <aside class="chat-nav">
      <ThreadsPane
        active={props.active}
        threads={props.threads}
        loading={props.threadsLoading}
        error={props.threadsError}
        profiles={props.profiles}
        homeLabel={props.homeLabel}
        draftProfileId={props.draftProfileId}
        onDraftProfileChange={props.onDraftProfileChange}
        onHome={props.onHome}
        onNew={props.onNew}
        onOpenThread={props.onOpenThread}
      />
    </aside>
  );
}

export function MobileProcessNav(props: {
  active: ThreadContext | null;
  threads: ProcessEntry[];
  threadsLoading: boolean;
  threadsError: string;
  profiles: Profile[];
  homeLabel: string;
  draftProfileId: string;
  onDraftProfileChange(profileId: string): void;
  onHome(): void;
  onNew(): void;
  onOpenThread(pid: string): void;
}) {
  const activePid = props.active?.pid ?? "";
  const isHome = props.active?.isHome === true;
  const selectedValue = isHome
    ? "home"
    : activePid
      ? `process:${activePid}`
      : "draft";
  const hasActiveProcess = Boolean(activePid && props.threads.some((thread) => thread.pid === activePid));
  const showDraftOption = !props.active || selectedValue === "draft";
  const status = props.threadsLoading
    ? "Refreshing..."
    : props.threadsError
      || (props.threads.length === 0
        ? "No other chats"
        : `${props.threads.length} chat${props.threads.length === 1 ? "" : "s"}`);

  const switchProcess = (event: Event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value === "home") {
      props.onHome();
      return;
    }
    if (value.startsWith("process:")) {
      props.onOpenThread(value.slice("process:".length));
    }
  };

  return (
    <section class="mobile-process-nav" aria-label="Chat navigation">
      <div class="mobile-process-row">
        <label class="mobile-process-select">
          <ThreadsIcon />
          <select value={selectedValue} aria-label="Switch chat" onChange={switchProcess}>
            {showDraftOption ? (
              <option value="draft">{props.active ? "Current chat" : "New chat"}</option>
            ) : null}
            <option value="home">{props.homeLabel}</option>
            {activePid && !hasActiveProcess ? (
              <option value={`process:${activePid}`}>Current chat</option>
            ) : null}
            {props.threads.map((thread) => (
              <option key={thread.pid} value={`process:${thread.pid}`}>
                {displayThreadLabel(thread)}
              </option>
            ))}
          </select>
        </label>
        <div class="mobile-process-actions">
          <button class="icon-button" type="button" title="New chat" aria-label="New chat" onClick={props.onNew}>
            <PlusIcon />
          </button>
        </div>
      </div>
      <div class="mobile-process-row is-secondary">
        <label class="mobile-profile-select">
          <span>Agent</span>
          <select
            value={props.draftProfileId}
            aria-label="Agent"
            onChange={(event) => props.onDraftProfileChange((event.currentTarget as HTMLSelectElement).value)}
          >
            {props.profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.displayName}</option>
            ))}
          </select>
        </label>
        <span class="mobile-process-status">{status}</span>
      </div>
    </section>
  );
}

function ThreadsPane(props: {
  active: ThreadContext | null;
  threads: ProcessEntry[];
  loading: boolean;
  error: string;
  profiles: Profile[];
  homeLabel: string;
  draftProfileId: string;
  onDraftProfileChange(profileId: string): void;
  onHome(): void;
  onNew(): void;
  onOpenThread(pid: string): void;
}) {
  const activePid = props.active?.pid ?? "";
  const isHome = props.active?.isHome === true;
  const homeProfile = props.profiles.find((profile) =>
    profile.spawnMode === "default" ||
    profile.id === "personal" ||
    profile.kind === "personal-agent"
  );
  const homeSeed = homeProfile?.newProcessRunAs || homeProfile?.runAs || homeProfile?.id || props.homeLabel;
  const draftProfile = props.profiles.find((profile) => isSelectedProfile(profile, props.draftProfileId))
    ?? props.profiles[0];
  const listNotice = props.loading
    ? "Refreshing chats..."
    : props.error || (props.threads.length === 0 ? "No other chats yet." : "");

  return (
    <section class="nav-pane">
      <header class="nav-pane-header">
        <div>
          <h1>Chats</h1>
        </div>
        <div class="nav-pane-actions">
          <button class="icon-button small" type="button" title="New chat" aria-label="New chat" onClick={props.onNew}>
            <PlusIcon />
          </button>
        </div>
      </header>

      <div class="new-thread-strip">
        <span class="agent-select-label">Agent</span>
        <details class="agent-dropdown">
          <summary class="agent-dropdown-trigger">
            <AgentAvatar seed={profileSeed(draftProfile)} label={draftProfile?.displayName || "Agent"} />
            <span class="agent-dropdown-copy">
              <span class="agent-dropdown-name">{draftProfile?.displayName || "Agent"}</span>
              <span class="agent-dropdown-meta">{profileMeta(draftProfile)}</span>
            </span>
            <ChevronDownIcon />
          </summary>
          <div class="agent-menu" role="listbox" aria-label="Agent">
            {props.profiles.map((profile) => (
              <button
                key={profile.id}
                class={"agent-option" + (isSelectedProfile(profile, props.draftProfileId) ? " is-active" : "")}
                type="button"
                role="option"
                aria-selected={isSelectedProfile(profile, props.draftProfileId)}
                onClick={(event) => selectProfile(event, profile.id, props.onDraftProfileChange)}
              >
                <AgentAvatar seed={profileSeed(profile)} label={profile.displayName} />
                <span>
                  <span class="agent-option-name">{profile.displayName}</span>
                  <span class="agent-option-meta">{profileMeta(profile)}</span>
                </span>
              </button>
            ))}
          </div>
        </details>
      </div>

      <nav class="thread-list" aria-label="Chats">
        <button type="button" class={"thread-row" + (isHome ? " is-active" : "")} onClick={props.onHome}>
          <AgentAvatar seed={homeSeed} label={props.homeLabel} />
          <span class="thread-row-title">{props.homeLabel}</span>
          <span class="thread-row-meta">Default chat</span>
          <span class="thread-row-status is-ready" title="Ready" aria-label="Ready" />
        </button>
        {listNotice ? <div class="thread-list-notice">{listNotice}</div> : null}
        {props.threads.map((thread) => (
          <button
            key={thread.pid}
            type="button"
            class={"thread-row" + (activePid === thread.pid ? " is-active" : "")}
            onClick={() => props.onOpenThread(thread.pid)}
          >
            <AgentAvatar seed={thread.username || thread.profile || thread.pid} label={thread.username || thread.profile || displayThreadLabel(thread)} />
            <span class="thread-row-title">{displayThreadLabel(thread)}</span>
            <span class="thread-row-meta">
              {threadMeta(thread)}
              {" - "}
              {formatRelativeTime(thread.createdAt)}
            </span>
            <span class={`thread-row-status ${threadStatusClass(thread)}`} title={threadStatusLabel(thread)} aria-label={threadStatusLabel(thread)} />
          </button>
        ))}
      </nav>
    </section>
  );
}

function selectProfile(event: MouseEvent, profileId: string, onSelect: (profileId: string) => void): void {
  onSelect(profileId);
  const details = (event.currentTarget as HTMLElement).closest("details");
  if (details) {
    details.open = false;
  }
}

function isSelectedProfile(profile: Profile, selectedId: string): boolean {
  return profile.id === selectedId || profile.alias === selectedId;
}

function profileSeed(profile: Profile | undefined): string {
  return profile?.newProcessRunAs || profile?.runAs || profile?.id || profile?.displayName || "agent";
}

function profileMeta(profile: Profile | undefined): string {
  if (!profile) return "Available agent";
  if (profile.spawnMode === "default" || profile.id === "personal" || profile.kind === "personal-agent") {
    return "Personal agent";
  }
  return profile.runAs || profile.newProcessRunAs || profile.kind || "Agent";
}

function threadMeta(thread: ProcessEntry): string {
  if (thread.activeRunId) return "Running";
  if (thread.queuedCount > 0) return `${thread.queuedCount} queued`;
  return thread.username || thread.profile || thread.state;
}

function threadStatusClass(thread: ProcessEntry): string {
  if (thread.activeRunId) return "is-running";
  if (thread.queuedCount > 0) return "is-queued";
  if (thread.state && thread.state !== "running") return "is-muted";
  return "is-ready";
}

function threadStatusLabel(thread: ProcessEntry): string {
  if (thread.activeRunId) return "Running";
  if (thread.queuedCount > 0) return `${thread.queuedCount} queued`;
  if (thread.state && thread.state !== "running") return thread.state;
  return "Ready";
}
