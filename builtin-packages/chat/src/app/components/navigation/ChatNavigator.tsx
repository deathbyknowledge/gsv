import type { ProcessEntry, Profile, ThreadContext } from "../../types";
import { PlusIcon, RefreshIcon, ThreadsIcon } from "../../icons";
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
  onRefreshThreads(): void;
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
        onRefresh={props.onRefreshThreads}
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
  onRefreshThreads(): void;
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
        ? "No extra processes"
        : `${props.threads.length} process${props.threads.length === 1 ? "" : "es"}`);

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
    <section class="mobile-process-nav" aria-label="Process navigation">
      <div class="mobile-process-row">
        <label class="mobile-process-select">
          <ThreadsIcon />
          <select value={selectedValue} aria-label="Switch process" onChange={switchProcess}>
            {showDraftOption ? (
              <option value="draft">{props.active ? "Current process" : "New draft"}</option>
            ) : null}
            <option value="home">{props.homeLabel}</option>
            {activePid && !hasActiveProcess ? (
              <option value={`process:${activePid}`}>Current process</option>
            ) : null}
            {props.threads.map((thread) => (
              <option key={thread.pid} value={`process:${thread.pid}`}>
                {displayThreadLabel(thread)}
              </option>
            ))}
          </select>
        </label>
        <div class="mobile-process-actions">
          <button class="icon-button" type="button" title="New process" aria-label="New process" onClick={props.onNew}>
            <PlusIcon />
          </button>
          <button class="icon-button" type="button" title="Refresh processes" aria-label="Refresh processes" onClick={props.onRefreshThreads}>
            <RefreshIcon />
          </button>
        </div>
      </div>
      <div class="mobile-process-row is-secondary">
        <label class="mobile-profile-select">
          <span>Profile</span>
          <select
            value={props.draftProfileId}
            aria-label="Profile"
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
  onRefresh(): void;
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
  const status = props.loading
    ? "Refreshing..."
    : props.error || (props.threads.length === 0 ? "No extra processes yet." : "Processes");

  return (
    <section class="nav-pane">
      <header class="nav-pane-header">
        <div>
          <h1>Processes</h1>
          <p>{status}</p>
        </div>
        <div class="nav-pane-actions">
          <button class="icon-button small" type="button" title="New process" aria-label="New process" onClick={props.onNew}>
            <PlusIcon />
          </button>
          <button class="icon-button small" type="button" title="Refresh processes" aria-label="Refresh processes" onClick={props.onRefresh}>
            <RefreshIcon />
          </button>
        </div>
      </header>

      <div class="new-thread-strip">
        <label>
          <span>Profile</span>
          <select value={props.draftProfileId} onChange={(event) => props.onDraftProfileChange((event.currentTarget as HTMLSelectElement).value)}>
            {props.profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.displayName}</option>
            ))}
          </select>
        </label>
      </div>

      <nav class="thread-list" aria-label="Chat processes">
        <button type="button" class={"thread-row" + (isHome ? " is-active" : "")} onClick={props.onHome}>
          <AgentAvatar seed={homeSeed} label={props.homeLabel} />
          <span class="thread-row-title">{props.homeLabel}</span>
          <span class="thread-row-meta">Default personal conversation</span>
        </button>
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
              {thread.profile}
              {" - "}
              {formatRelativeTime(thread.createdAt)}
            </span>
          </button>
        ))}
      </nav>
    </section>
  );
}
