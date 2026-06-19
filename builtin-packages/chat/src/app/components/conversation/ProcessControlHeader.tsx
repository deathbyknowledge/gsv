import type { ComponentChildren } from "preact";
import { openApp } from "@humansandmachines/gsv/sdk/host";
import type {
  ContextState,
  ProcessAiState,
  ProcessEntry,
  ThreadContext,
} from "../../types";
import {
  PROCESS_AI_REASONING_LEVELS,
  processAiHasLocalOverride,
  processAiModelLabel,
  processAiProfileIsActive,
  processAiProfileSummary,
  processAiProviderLabel,
  processAiReasoningIsActive,
  processAiReasoningLabel,
  type ProcessAiReasoningLevel,
} from "../../domain/process-ai";
import {
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  CompactIcon,
  CopyIcon,
  GaugeIcon,
  MaximizeIcon,
  PlusIcon,
} from "../../icons";
import {
  closeChatMenus,
  closeContainingChatMenu,
  displayThreadLabel,
  formatRelativeTime,
  shortId,
} from "../../view-helpers";
import { AgentAvatar } from "../navigation/AgentAvatar";
import { ContextMeter } from "./ContextMeter";

export function ProcessControlHeader(props: {
  active: ThreadContext | null;
  activeThread: ProcessEntry | null;
  activeTitle: string;
  agentLabel: string;
  agentSeed: string;
  processLabel: string;
  runStateClass: string;
  runStateLabel: string;
  statusText: string;
  threads: ProcessEntry[];
  homeThread: ProcessEntry | null;
  homeLabel: string;
  contextState: ContextState | null;
  archiveCount: number;
  conversationControls?: ComponentChildren;
  processAiState: ProcessAiState | null;
  processAiLoading: boolean;
  processAiPendingAction: string | null;
  processAiError: string;
  canFreeContext: boolean;
  compactBusy: boolean;
  onHome(): void;
  onOpenThread(pid: string): void;
  onNewTask(): void;
  onCopyTaskId(): void;
  onSetReasoning(level: ProcessAiReasoningLevel): void;
  onApplyProfile(profileId: string): void;
  onClearModelOverride(): void;
  onFreeContext(): void;
  onOpenArchive(): void;
  onToggleFullscreen(): void;
}) {
  const modelLabel = processAiModelLabel(props.processAiState, props.contextState);
  const providerLabel = processAiProviderLabel(props.processAiState, props.contextState);
  const reasoningLabel = processAiReasoningLabel(props.processAiState);
  const contextLabel = contextPercentLabel(props.contextState);

  return (
    <>
      <div class="chat-stage-title process-stage-title">
        <span class="process-avatar-stack">
          <AgentAvatar seed={props.agentSeed} label={props.agentLabel} />
          <span class={`process-avatar-status ${props.runStateClass}`} title={`${props.runStateLabel}: ${props.statusText}`} aria-label={`${props.runStateLabel}: ${props.statusText}`} />
        </span>
        <div class="chat-stage-title-main process-title-main">
          <div class="chat-stage-title-line process-title-line">
            <h1>{props.agentLabel}</h1>
            <span class={"stage-run-state " + props.runStateClass} title={`${props.runStateLabel}: ${props.statusText}`} aria-label={`${props.runStateLabel}: ${props.statusText}`}>
              {props.runStateClass !== "is-ready" ? <span>{props.runStateLabel}</span> : null}
            </span>
          </div>

          <div class="process-model-row">
            <details class="process-menu process-inline-menu model-switcher">
              <summary
                class="process-inline-summary"
                title={`${providerLabel}/${modelLabel} - reasoning ${reasoningLabel}`}
                onClick={(event) => closeChatMenus((event.currentTarget as HTMLElement).closest("details") as HTMLDetailsElement | null)}
              >
                <span class="process-model-name">{modelLabel}</span>
                <span class="process-model-reasoning">{reasoningLabel}</span>
                <ChevronDownIcon />
              </summary>
              <div class="process-menu-popover model-menu-popover">
                <ModelMenu
                  state={props.processAiState}
                  loading={props.processAiLoading}
                  pendingAction={props.processAiPendingAction}
                  error={props.processAiError}
                  canEdit={Boolean(props.active)}
                  onSetReasoning={props.onSetReasoning}
                  onApplyProfile={props.onApplyProfile}
                  onClearModelOverride={props.onClearModelOverride}
                />
              </div>
            </details>
            <span class="process-model-provider">{providerLabel}</span>
          </div>

          <div class="process-task-row">
            <details class="process-menu process-inline-menu task-switcher">
              <summary
                class="process-inline-summary process-task-summary"
                title={props.active?.pid ? `${props.processLabel} (${props.active.pid})` : props.processLabel}
                onClick={(event) => closeChatMenus((event.currentTarget as HTMLElement).closest("details") as HTMLDetailsElement | null)}
              >
                <span>{props.processLabel}</span>
                <ChevronDownIcon />
              </summary>
              <div class="process-menu-popover task-menu-popover">
                <TaskMenu
                  active={props.active}
                  activeThread={props.activeThread}
                  activeTitle={props.activeTitle}
                  threads={props.threads}
                  homeThread={props.homeThread}
                  homeLabel={props.homeLabel}
                  onHome={props.onHome}
                  onOpenThread={props.onOpenThread}
                  onNewTask={props.onNewTask}
                  onCopyTaskId={props.onCopyTaskId}
                />
              </div>
            </details>
          </div>

          {props.conversationControls ? (
            <div class="process-branch-controls">
              {props.conversationControls}
            </div>
          ) : null}
        </div>
      </div>

      <div class="chat-stage-actions process-stage-actions">
        <details class="process-menu context-switcher">
          <summary
            class="context-menu-trigger"
            title="Context"
            aria-label="Context"
            onClick={(event) => closeChatMenus((event.currentTarget as HTMLElement).closest("details") as HTMLDetailsElement | null)}
          >
            <GaugeIcon />
            <span class="context-trigger-copy">
              <span>Context</span>
              <strong>{contextLabel}</strong>
            </span>
          </summary>
          <div class="process-menu-popover context-menu-popover">
            <div class="context-popover-head">
              <GaugeIcon />
              <span>Context</span>
              <strong>{contextLabel}</strong>
            </div>
            <ContextMeter state={props.contextState} />
            <button type="button" class="menu-action" disabled={!props.canFreeContext || props.compactBusy} onClick={(event) => {
              closeContainingChatMenu(event.currentTarget);
              props.onFreeContext();
            }}>
              <CompactIcon />
              <span>{props.compactBusy ? "Freeing context..." : "Free context"}</span>
            </button>
            <button type="button" class="menu-action" disabled={!props.active} onClick={(event) => {
              closeContainingChatMenu(event.currentTarget);
              props.onOpenArchive();
            }}>
              <ArchiveIcon />
              <span>{props.archiveCount > 0 ? `Open archive (${props.archiveCount})` : "Open archive"}</span>
            </button>
          </div>
        </details>

        <button type="button" class="icon-button fullscreen-action" title="Toggle fullscreen" aria-label="Toggle fullscreen" onClick={props.onToggleFullscreen}>
          <MaximizeIcon />
        </button>
      </div>
    </>
  );
}

function ModelMenu(props: {
  state: ProcessAiState | null;
  loading: boolean;
  pendingAction: string | null;
  error: string;
  canEdit: boolean;
  onSetReasoning(level: ProcessAiReasoningLevel): void;
  onApplyProfile(profileId: string): void;
  onClearModelOverride(): void;
}) {
  const busy = Boolean(props.pendingAction) || !props.canEdit;
  return (
    <div class="model-menu-content">
      <section class="model-menu-section">
        <span class="process-menu-kicker">Reasoning</span>
        <div class="model-reasoning-grid">
          {PROCESS_AI_REASONING_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              class={"model-reasoning-option" + (processAiReasoningIsActive(props.state, level) ? " is-active" : "")}
              disabled={busy}
              onClick={(event) => {
                closeContainingChatMenu(event.currentTarget);
                props.onSetReasoning(level);
              }}
            >
              <span>{capitalize(level)}</span>
              {processAiReasoningIsActive(props.state, level) ? <CheckIcon /> : null}
            </button>
          ))}
        </div>
      </section>

      <section class="model-menu-section">
        <span class="process-menu-kicker">Switch model</span>
        {!props.canEdit ? (
          <div class="process-menu-note">No active task.</div>
        ) : props.loading ? (
          <div class="process-menu-note">Loading models...</div>
        ) : props.state?.profiles.length ? (
          <div class="model-profile-list">
            {props.state.profiles.map((profile) => {
              const active = processAiProfileIsActive(props.state, profile);
              const actionId = `profile:${profile.id}`;
              return (
                <button
                  key={profile.id}
                  type="button"
                  class={"model-profile-option" + (active ? " is-active" : "")}
                  disabled={busy || active}
                  onClick={(event) => {
                    closeContainingChatMenu(event.currentTarget);
                    props.onApplyProfile(profile.id);
                  }}
                >
                  <span>
                    <strong>{profile.name}</strong>
                    <small>{processAiProfileSummary(profile)}</small>
                  </span>
                  {active || props.pendingAction === actionId ? <CheckIcon /> : null}
                </button>
              );
            })}
          </div>
        ) : (
          <div class="process-menu-note">No saved models.</div>
        )}
        {processAiHasLocalOverride(props.state) ? (
          <button
            type="button"
            class="model-menu-link"
            disabled={busy}
            onClick={(event) => {
              closeContainingChatMenu(event.currentTarget);
              props.onClearModelOverride();
            }}
          >
            Use defaults
          </button>
        ) : null}
        <button type="button" class="model-menu-link" onClick={(event) => {
          closeContainingChatMenu(event.currentTarget);
          openApp({ target: "gsv", payload: { route: "/apps/gsv/?section=settings" } });
        }}>
          New model
        </button>
      </section>

      {props.error ? <div class="process-menu-error">{props.error}</div> : null}
    </div>
  );
}

function TaskMenu(props: {
  active: ThreadContext | null;
  activeThread: ProcessEntry | null;
  activeTitle: string;
  threads: ProcessEntry[];
  homeThread: ProcessEntry | null;
  homeLabel: string;
  onHome(): void;
  onOpenThread(pid: string): void;
  onNewTask(): void;
  onCopyTaskId(): void;
}) {
  const activePid = props.active?.pid ?? "";
  const rows = buildTaskRows(props);
  return (
    <div class="task-menu-content">
      <div class="task-menu-head">
        <span class="process-menu-kicker">{props.active ? displayTaskLabel(props.active, props.activeThread, props.activeTitle, props.homeLabel) : "New task"}</span>
        {activePid ? <small>{shortId(activePid)}</small> : null}
      </div>
      <button type="button" class="menu-action" disabled={!activePid} onClick={(event) => {
        closeContainingChatMenu(event.currentTarget);
        props.onCopyTaskId();
      }}>
        <CopyIcon />
        <span>Copy task ID</span>
      </button>
      <div class="task-option-list">
        {rows.map((row) => (
          <button
            key={row.key}
            type="button"
            class={"task-option" + (row.active ? " is-active" : "")}
            disabled={row.active}
            onClick={(event) => {
              closeContainingChatMenu(event.currentTarget);
              if (row.kind === "home") {
                props.onHome();
              } else if (row.pid) {
                props.onOpenThread(row.pid);
              }
            }}
          >
            <span class={`task-status-dot ${row.statusClass}`} title={row.statusLabel} aria-label={row.statusLabel} />
            <span>
              <strong>{row.label}</strong>
              <small>{row.meta}</small>
            </span>
          </button>
        ))}
      </div>
      <button type="button" class="menu-action" onClick={(event) => {
        closeContainingChatMenu(event.currentTarget);
        props.onNewTask();
      }}>
        <PlusIcon />
        <span>New task</span>
      </button>
    </div>
  );
}

type TaskRow = {
  key: string;
  kind: "home" | "process";
  pid: string;
  label: string;
  meta: string;
  active: boolean;
  statusClass: string;
  statusLabel: string;
};

function buildTaskRows(props: {
  active: ThreadContext | null;
  activeThread: ProcessEntry | null;
  activeTitle: string;
  threads: ProcessEntry[];
  homeThread: ProcessEntry | null;
  homeLabel: string;
}): TaskRow[] {
  const activePid = props.active?.pid ?? "";
  const rows: TaskRow[] = [];
  const seen = new Set<string>();
  rows.push({
    key: "home",
    kind: "home",
    pid: props.homeThread?.pid ?? "",
    label: props.homeLabel,
    meta: props.homeThread ? taskMeta(props.homeThread) : "Default task",
    active: props.active?.isHome === true,
    statusClass: props.homeThread ? taskStatusClass(props.homeThread) : "is-ready",
    statusLabel: props.homeThread ? taskStatusLabel(props.homeThread) : "Ready",
  });
  if (props.homeThread?.pid) {
    seen.add(props.homeThread.pid);
  }
  if (props.active && !props.active.isHome && activePid && !props.threads.some((thread) => thread.pid === activePid)) {
    rows.push({
      key: `active:${activePid}`,
      kind: "process",
      pid: activePid,
      label: props.activeTitle || "Current task",
      meta: "Current task",
      active: true,
      statusClass: "is-ready",
      statusLabel: "Ready",
    });
    seen.add(activePid);
  }
  for (const thread of props.threads) {
    if (seen.has(thread.pid)) {
      continue;
    }
    rows.push({
      key: thread.pid,
      kind: "process",
      pid: thread.pid,
      label: displayThreadLabel(thread),
      meta: `${taskMeta(thread)} - ${formatRelativeTime(thread.createdAt)}`,
      active: activePid === thread.pid && props.active?.isHome !== true,
      statusClass: taskStatusClass(thread),
      statusLabel: taskStatusLabel(thread),
    });
    seen.add(thread.pid);
  }
  return rows.slice(0, 12);
}

function displayTaskLabel(active: ThreadContext, activeThread: ProcessEntry | null, activeTitle: string, homeLabel: string): string {
  if (active.isHome) {
    return homeLabel;
  }
  return activeThread ? displayThreadLabel(activeThread) : activeTitle || "Current task";
}

function taskMeta(thread: ProcessEntry): string {
  if (thread.activeRunId) return "Running";
  if (thread.queuedCount > 0) return `${thread.queuedCount} queued`;
  return thread.username || thread.profile || thread.state;
}

function taskStatusClass(thread: ProcessEntry): string {
  if (thread.activeRunId) return "is-running";
  if (thread.queuedCount > 0) return "is-queued";
  if (thread.state && thread.state !== "running") return "is-muted";
  return "is-ready";
}

function taskStatusLabel(thread: ProcessEntry): string {
  if (thread.activeRunId) return "Running";
  if (thread.queuedCount > 0) return `${thread.queuedCount} queued`;
  if (thread.state && thread.state !== "running") return thread.state;
  return "Ready";
}

function contextPercentLabel(state: ContextState | null): string {
  if (!state || state.pressure === null) {
    return "?";
  }
  return `${Math.round(Math.max(0, Math.min(1, state.pressure)) * 100)}%`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
