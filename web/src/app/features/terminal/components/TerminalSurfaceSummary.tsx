import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { Icon } from "../../../components/ui/Icon";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { Select } from "../../../components/ui/Select";
import { Spinner } from "../../../components/ui/Spinner";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import { Tag, type TagTone } from "../../../components/ui/Tag";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { ConsolePage } from "../../gsv-console/components/ConsolePageTemplate";
import type { TerminalCommandInput, TerminalTarget, TerminalTranscriptEntry } from "../domain/models";
import { useTerminalCommandMutation, useTerminalTargets } from "../hooks/useTerminalQueries";
import "./TerminalSurfaceSummary.css";

type TargetOption = {
  id: string;
  label: string;
  detail: string;
  online: boolean;
  native: boolean;
};

type CommandSnapshot = {
  input: string;
  target: string;
  sessionId: string;
  cwd: string;
  timeoutMs: string;
  yieldMs: string;
  background: boolean;
};

type CommandHistoryItem = CommandSnapshot & {
  id: string;
  startedAt: number;
  completedAt: number;
  status: TerminalTranscriptEntry["status"];
  exitCode: number | null;
  resultSessionId: string | null;
  truncated: boolean;
  stdoutLines: number;
  stdoutChars: number;
  stderrLines: number;
  stderrChars: number;
  errorText: string;
};

const NATIVE_TARGET_ID = "gsv";
const MAX_HISTORY_ITEMS = 16;

type StreamFilter = "all" | "stdout" | "stderr";

function buildTargetOptions(targets: readonly TerminalTarget[], connected: boolean): TargetOption[] {
  return [
    {
      id: NATIVE_TARGET_ID,
      label: "GSV",
      detail: "Native gateway shell",
      online: connected,
      native: true,
    },
    ...targets
      .filter((target) => target.id !== NATIVE_TARGET_ID)
      .map((target) => ({
        id: target.id,
        label: target.label || target.id,
        detail: [target.platform, target.description].filter(Boolean).join(" · "),
        online: target.online,
        native: false,
      })),
  ];
}

function optionLabel(option: TargetOption): string {
  const state = option.online ? "ONLINE" : "OFFLINE";
  return option.native ? `GSV · NATIVE · ${state}` : `${option.label} · ${option.id} · ${state}`;
}

function statusToneForTarget(target: TargetOption | TerminalTarget): StatusTone {
  return target.online ? "online" : "idle";
}

function statusTone(status: TerminalTranscriptEntry["status"]): TagTone {
  if (status === "failed") return "error";
  if (status === "running") return "update";
  return "online";
}

function statusLabel(status: TerminalTranscriptEntry["status"]): string {
  if (status === "running") return "RUNNING";
  if (status === "failed") return "FAILED";
  return "COMPLETED";
}

function resultTone(entry: TerminalTranscriptEntry): TagTone {
  return statusTone(entry.status);
}

function resultLabel(entry: TerminalTranscriptEntry): string {
  return statusLabel(entry.status);
}

function resultMeta(entry: TerminalTranscriptEntry): string {
  const parts = [
    entry.background ? "BACKGROUND" : "",
    entry.exitCode === null ? "" : `EXIT ${entry.exitCode}`,
    entry.sessionId ? "SESSION" : "",
    entry.truncated ? "TRUNCATED" : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function formatDuration(startedAt: number, completedAt: number): string {
  const duration = Math.max(0, completedAt - startedAt);
  return `${duration}ms`;
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function countLines(value: string): number {
  return value.length === 0 ? 0 : value.split(/\r\n|\r|\n/).length;
}

function pluralize(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function streamMeta(value: string): string {
  const lineCount = countLines(value);
  return `${pluralize(lineCount, "line")} · ${pluralize(value.length, "char")}`;
}

function streamShortMeta(value: string): string {
  if (value.length === 0) return "EMPTY";
  return `${countLines(value)}L / ${value.length}C`;
}

function displayCommand(entry: TerminalTranscriptEntry): string {
  if (entry.command.length > 0) {
    return entry.command;
  }
  return entry.sessionId ? `session ${entry.sessionId}` : "shell.exec";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : "Command failed.";
}

function cleanSnapshot(snapshot: CommandSnapshot): CommandSnapshot {
  return {
    input: snapshot.input.trim(),
    target: snapshot.target.trim() || NATIVE_TARGET_ID,
    sessionId: snapshot.sessionId.trim(),
    cwd: snapshot.cwd.trim(),
    timeoutMs: snapshot.timeoutMs.trim(),
    yieldMs: snapshot.yieldMs.trim(),
    background: snapshot.background,
  };
}

function createHistoryItem(
  snapshot: CommandSnapshot,
  startedAt: number,
  entry?: TerminalTranscriptEntry,
  error?: unknown,
): CommandHistoryItem {
  const completedAt = entry?.completedAt ?? Date.now();
  return {
    ...snapshot,
    id: entry?.id ?? `${startedAt}-${completedAt}`,
    startedAt: entry?.startedAt ?? startedAt,
    completedAt,
    status: entry?.status ?? "failed",
    exitCode: entry?.exitCode ?? null,
    resultSessionId: entry?.sessionId ?? null,
    truncated: entry?.truncated ?? false,
    stdoutLines: entry ? countLines(entry.stdout) : 0,
    stdoutChars: entry?.stdout.length ?? 0,
    stderrLines: entry ? countLines(entry.stderr) : 0,
    stderrChars: entry?.stderr.length ?? 0,
    errorText: error ? errorText(error) : "",
  };
}

function historyMeta(item: CommandHistoryItem): string {
  const parts = [
    item.sessionId ? `SESSION ${item.sessionId}` : item.target,
    item.cwd ? `CWD ${item.cwd}` : "",
    item.background ? "BACKGROUND" : "",
    item.exitCode === null ? "" : `EXIT ${item.exitCode}`,
    item.resultSessionId ? `RESULT ${item.resultSessionId}` : "",
    item.truncated ? "TRUNCATED" : "",
    item.stdoutChars > 0 ? `OUT ${item.stdoutLines}L` : "",
    item.stderrChars > 0 ? `ERR ${item.stderrLines}L` : "",
    formatDuration(item.startedAt, item.completedAt),
  ].filter(Boolean);
  return parts.join(" · ");
}

function historyTitle(item: CommandHistoryItem): string {
  if (item.input.length > 0) {
    return item.input;
  }
  return item.sessionId ? `poll ${item.sessionId}` : "shell.exec";
}

function TerminalInlineState({
  kind,
  title,
  detail,
  action,
}: {
  kind: "loading" | "error" | "empty" | "offline";
  title: string;
  detail: string;
  action?: JSX.Element;
}) {
  const tone: StatusTone = kind === "error" ? "error" : kind === "loading" ? "live" : "idle";
  return (
    <div class={`terminal-inline-state is-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <StatusDot tone={tone} size={8} />
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      {action ? <div class="terminal-inline-action">{action}</div> : null}
    </div>
  );
}

function TargetInventory({
  targets,
  loading,
  error,
  empty,
  offline,
  selectedId,
  disabled,
  onSelect,
  onRetry,
}: {
  targets: readonly TargetOption[];
  loading: boolean;
  error: string;
  empty: boolean;
  offline: boolean;
  selectedId: string;
  disabled: boolean;
  onSelect: (targetId: string) => void;
  onRetry: () => void;
}) {
  return (
    <div class="terminal-target-stack">
      {offline ? (
        <TerminalInlineState
          kind="offline"
          title="Gateway offline"
          detail="Reconnect to refresh targets or run commands."
        />
      ) : null}
      {!offline && loading ? (
        <TerminalInlineState
          kind="loading"
          title="Loading targets"
          detail="Reading command targets from the gateway."
        />
      ) : null}
      {!offline && error ? (
        <TerminalInlineState
          kind="error"
          title="Target load failed"
          detail={error}
          action={<Button variant="secondary" label="RETRY" onClick={onRetry} />}
        />
      ) : null}
      {!offline && !loading && !error && empty ? (
        <TerminalInlineState
          kind="empty"
          title="No remote targets"
          detail="The native GSV shell is still available."
        />
      ) : null}
      <div class="terminal-target-list" aria-label="Command targets">
        {targets.map((target) => {
          const active = target.id === selectedId;
          return (
            <button
              class={`terminal-target-row${active ? " is-active" : ""}${target.online ? "" : " is-offline"}`}
              type="button"
              key={target.id}
              disabled={disabled}
              onClick={() => onSelect(target.id)}
            >
              <span class="terminal-target-icon">
                <Icon name={target.native ? "terminal" : "computer"} size={16} />
              </span>
              <span class="terminal-target-copy">
                <strong>{target.label}</strong>
                <span>{target.detail || target.id}</span>
              </span>
              <span class="terminal-target-state">
                <Tag tone={target.online ? "online" : "idle"} label={target.online ? "ONLINE" : "OFFLINE"} boxed dot />
                <Tag tone={target.native ? "accent" : "info"} label={target.native ? "NATIVE" : "DEVICE"} boxed />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CommandOutput({
  entry,
  pending,
  error,
  streamFilter,
  pollDisabled,
  onStreamFilterChange,
  onPollSession,
}: {
  entry: TerminalTranscriptEntry | undefined;
  pending: boolean;
  error: unknown;
  streamFilter: StreamFilter;
  pollDisabled: boolean;
  onStreamFilterChange: (filter: StreamFilter) => void;
  onPollSession: (entry: TerminalTranscriptEntry) => void;
}) {
  if (pending) {
    return (
      <div class="terminal-output-state" role="status" aria-live="polite">
        <Spinner size={18} />
        <span>Running command</span>
      </div>
    );
  }

  if (error) {
    return (
      <div class="terminal-output-error" role="alert">
        <strong>Command failed</strong>
        <pre>{errorText(error)}</pre>
      </div>
    );
  }

  if (!entry) {
    return (
      <div class="terminal-output-state">
        <Icon name="terminal" size={20} />
        <span>No command output yet</span>
      </div>
    );
  }

  const hasStdout = entry.stdout.length > 0;
  const hasStderr = entry.stderr.length > 0;
  const showStdout = hasStdout && (streamFilter === "all" || streamFilter === "stdout");
  const showStderr = hasStderr && (streamFilter === "all" || streamFilter === "stderr");
  const meta = resultMeta(entry);
  const resultRows = [
    ["TARGET", entry.target],
    ["CWD", entry.cwd || "DEFAULT"],
    ["STARTED", formatTimestamp(entry.startedAt)],
    ["RETURNED", formatTimestamp(entry.completedAt)],
    ["DURATION", formatDuration(entry.startedAt, entry.completedAt)],
    ["MODE", entry.background ? "BACKGROUND" : "FOREGROUND"],
    entry.timeoutMs === null ? null : ["TIMEOUT", `${entry.timeoutMs}MS`],
    entry.background && entry.yieldMs !== null ? ["YIELD", `${entry.yieldMs}MS`] : null,
    entry.exitCode === null ? null : ["EXIT", String(entry.exitCode)],
    entry.sessionId ? ["SESSION", entry.sessionId] : null,
    entry.truncated ? ["OUTPUT", "TRUNCATED"] : null,
  ].filter((row): row is [string, string] => row !== null);

  return (
    <div class="terminal-transcript" aria-live="polite">
      <div class="terminal-transcript-header">
        <div>
          <span>{entry.target}</span>
          <strong>{displayCommand(entry)}</strong>
          {entry.cwd ? <small>{entry.cwd}</small> : null}
        </div>
        <div class="terminal-transcript-tags">
          <Tag tone={resultTone(entry)} label={resultLabel(entry)} boxed />
          <Tag tone={entry.background ? "update" : "idle"} label={entry.background ? "BACKGROUND" : "FOREGROUND"} boxed />
          {entry.exitCode === null ? null : <Tag tone={entry.exitCode === 0 ? "online" : "error"} label={`EXIT ${entry.exitCode}`} boxed />}
          {entry.sessionId ? <Tag tone="info" label="SESSION" boxed /> : null}
          {entry.truncated ? <Tag tone="warn" label="TRUNCATED" boxed /> : null}
          <Tag tone="info" label={formatDuration(entry.startedAt, entry.completedAt)} boxed />
        </div>
      </div>
      {entry.sessionId || entry.background || meta ? (
        <div class="terminal-session-strip">
          <div class="terminal-session-copy">
            <StatusDot tone={entry.status === "running" ? "live" : entry.status === "failed" ? "error" : "online"} size={8} />
            <div>
              <strong>{entry.sessionId ? entry.sessionId : entry.background ? "background command" : "command result"}</strong>
              <span>{meta || "FOREGROUND"}</span>
            </div>
          </div>
          {entry.sessionId ? (
            <Button
              variant="secondary"
              label="POLL SESSION"
              disabled={pollDisabled}
              onClick={() => onPollSession(entry)}
            />
          ) : null}
        </div>
      ) : null}
      <dl class="terminal-result-meta">
        {resultRows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {!hasStdout && !hasStderr ? (
        <div class="terminal-output-state is-compact">
          <span>{entry.status === "running" ? "Command is still running with no returned output" : "Command completed with no output"}</span>
        </div>
      ) : null}
      {hasStdout || hasStderr ? (
        <div class="terminal-stream-toolbar">
          <div class="terminal-stream-summary">
            <Tag tone={hasStdout ? "info" : "idle"} label={`STDOUT ${streamShortMeta(entry.stdout)}`} boxed />
            <Tag tone={hasStderr ? "warn" : "idle"} label={`STDERR ${streamShortMeta(entry.stderr)}`} boxed />
          </div>
          <div class="terminal-stream-actions" aria-label="Output stream filter">
            <Button
              variant={streamFilter === "all" ? "primary" : "secondary"}
              label="ALL"
              onClick={() => onStreamFilterChange("all")}
            />
            <Button
              variant={streamFilter === "stdout" ? "primary" : "secondary"}
              label="STDOUT"
              disabled={!hasStdout}
              onClick={() => onStreamFilterChange("stdout")}
            />
            <Button
              variant={streamFilter === "stderr" ? "primary" : "secondary"}
              label="STDERR"
              disabled={!hasStderr}
              onClick={() => onStreamFilterChange("stderr")}
            />
          </div>
        </div>
      ) : null}
      {showStdout ? (
        <section class="terminal-stream">
          <div class="terminal-stream-header">
            <span>STDOUT</span>
            <small>{streamMeta(entry.stdout)}</small>
          </div>
          <pre>{entry.stdout}</pre>
        </section>
      ) : null}
      {showStderr ? (
        <section class="terminal-stream is-error">
          <div class="terminal-stream-header">
            <span>STDERR</span>
            <small>{streamMeta(entry.stderr)}</small>
          </div>
          <pre>{entry.stderr}</pre>
        </section>
      ) : null}
    </div>
  );
}

function CommandHistory({
  history,
  pending,
  canRerun,
  onLoad,
  onRerun,
  onClear,
}: {
  history: readonly CommandHistoryItem[];
  pending: boolean;
  canRerun: (item: CommandHistoryItem) => boolean;
  onLoad: (item: CommandHistoryItem) => void;
  onRerun: (item: CommandHistoryItem) => void;
  onClear: () => void;
}) {
  return (
    <div class="terminal-history">
      <div class="terminal-history-header">
        <span>LOCAL HISTORY</span>
        <Button
          variant="secondary"
          label="CLEAR HISTORY"
          disabled={pending || history.length === 0}
          onClick={onClear}
        />
      </div>
      {history.length === 0 ? (
        <div class="terminal-history-empty">No commands run in this view</div>
      ) : (
        <div class="terminal-history-list" aria-label="Local command history">
          {history.map((item) => {
            const rerunDisabled = !canRerun(item);
            return (
              <div class="terminal-history-row" key={item.id}>
                <div class="terminal-history-copy">
                  <strong>{historyTitle(item)}</strong>
                  <span>{historyMeta(item)}</span>
                  {item.errorText ? <small>{item.errorText}</small> : null}
                </div>
                <div class="terminal-history-side">
                  <Tag tone={statusTone(item.status)} label={statusLabel(item.status)} boxed />
                  {item.input.length > 0 && !item.sessionId ? (
                    <Button
                      variant="secondary"
                      label="LOAD"
                      disabled={pending}
                      onClick={() => onLoad(item)}
                    />
                  ) : null}
                  <Button
                    variant="secondary"
                    label={item.sessionId ? "POLL" : "RERUN"}
                    disabled={rerunDisabled}
                    onClick={() => onRerun(item)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TerminalSurfaceSummary() {
  const { connected } = useGateway();
  const targets = useTerminalTargets();
  const command = useTerminalCommandMutation();
  const [selectedTargetId, setSelectedTargetId] = useState(NATIVE_TARGET_ID);
  const [cwd, setCwd] = useState("");
  const [timeoutMs, setTimeoutMs] = useState("");
  const [yieldMs, setYieldMs] = useState("");
  const [background, setBackground] = useState(false);
  const [commandInput, setCommandInput] = useState("");
  const [history, setHistory] = useState<CommandHistoryItem[]>([]);
  const [streamFilter, setStreamFilter] = useState<StreamFilter>("all");

  const targetOptions = useMemo(
    () => buildTargetOptions(targets.targets, connected),
    [connected, targets.targets],
  );
  const selectedTarget = targetOptions.find((option) => option.id === selectedTargetId) ?? targetOptions[0];
  const selectedTargetIndex = Math.max(0, targetOptions.findIndex((option) => option.id === selectedTarget.id));
  const targetSelectOptions = targetOptions.map(optionLabel);
  const targetLoadError = targets.resource.isError ? targets.resource.errorText || "Unable to load command targets." : "";
  const targetEmpty = targets.resource.isEmpty || targets.targets.length === 0;
  const selectedTargetOffline = !selectedTarget.online;
  const currentCommand = cleanSnapshot({
    input: commandInput,
    target: selectedTarget.id,
    sessionId: "",
    cwd,
    timeoutMs,
    yieldMs,
    background,
  });
  const commandIsBlank = currentCommand.input.length === 0;
  const runDisabled = !canExecuteCommand(currentCommand);
  const outputMeta = command.isPending
    ? "RUNNING"
    : command.data
      ? command.data.sessionId
        ? `${resultLabel(command.data)} · SESSION`
        : resultLabel(command.data)
      : command.error
        ? "ERROR"
        : "IDLE";

  useEffect(() => {
    if (!targetOptions.some((option) => option.id === selectedTargetId)) {
      setSelectedTargetId(NATIVE_TARGET_ID);
    }
  }, [selectedTargetId, targetOptions]);

  useEffect(() => {
    if (!command.data) {
      return;
    }
    if (streamFilter === "stdout" && command.data.stdout.length === 0) {
      setStreamFilter("all");
    }
    if (streamFilter === "stderr" && command.data.stderr.length === 0) {
      setStreamFilter("all");
    }
  }, [command.data, streamFilter]);

  const runCommand = () => {
    executeCommand(currentCommand);
  };

  const executeCommand = (snapshot: CommandSnapshot) => {
    const request = cleanSnapshot(snapshot);
    if (!canExecuteCommand(request)) {
      return;
    }

    const startedAt = Date.now();
    const payload: TerminalCommandInput = {
      input: request.input,
      target: request.target,
      sessionId: request.sessionId,
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      yieldMs: request.yieldMs,
      background: request.background,
    };
    command.mutate(payload, {
      onSuccess: (entry) => rememberCommand(request, startedAt, entry),
      onError: (error) => rememberCommand(request, startedAt, undefined, error),
    });
  };

  function canExecuteCommand(snapshot: CommandSnapshot): boolean {
    const request = cleanSnapshot(snapshot);
    const target = targetOptions.find((option) => option.id === request.target);
    if (!connected || command.isPending) {
      return false;
    }
    if (request.sessionId.length > 0) {
      return true;
    }
    return request.input.length > 0 && Boolean(target?.online);
  }

  function rememberCommand(
    snapshot: CommandSnapshot,
    startedAt: number,
    entry?: TerminalTranscriptEntry,
    error?: unknown,
  ): void {
    setHistory((items) => [
      createHistoryItem(snapshot, startedAt, entry, error),
      ...items,
    ].slice(0, MAX_HISTORY_ITEMS));
  }

  function loadHistoryItem(item: CommandHistoryItem): void {
    setSelectedTargetId(item.target);
    setCwd(item.cwd);
    setTimeoutMs(item.timeoutMs);
    setYieldMs(item.yieldMs);
    setBackground(item.background);
    setCommandInput(item.input);
  }

  function rerunHistoryItem(item: CommandHistoryItem): void {
    loadHistoryItem(item);
    executeCommand(item);
  }

  function pollSession(entry: TerminalTranscriptEntry): void {
    if (!entry.sessionId) {
      return;
    }
    executeCommand({
      input: "",
      target: entry.target,
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      timeoutMs: entry.timeoutMs === null ? "" : String(entry.timeoutMs),
      yieldMs: entry.yieldMs === null ? "" : String(entry.yieldMs),
      background: entry.background,
    });
  }

  const handleCommandKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      runCommand();
    }
  };

  return (
    <ConsolePage>
      <div class="terminal-surface">
        <section class="terminal-panel terminal-target-panel" aria-label="Terminal targets">
          <SectionHeader
            title="COMMAND TARGETS"
            meta={`${targetOptions.filter((target) => target.online).length}/${targetOptions.length} ONLINE`}
            divider
          />
          <div class="terminal-panel-body">
            <Select
              key={`${selectedTarget.id}:${targetSelectOptions.join("|")}`}
              label="TARGET"
              options={targetSelectOptions}
              value={selectedTargetIndex}
              width={360}
              disabled={command.isPending || targetOptions.length === 0}
              status={selectedTargetOffline ? "warning" : "none"}
              message={selectedTargetOffline ? "TARGET OFFLINE" : ""}
              onChange={(index) => {
                const nextTarget = targetOptions[index];
                if (nextTarget) {
                  setSelectedTargetId(nextTarget.id);
                }
              }}
            />
            <div class="terminal-selected-target">
              <StatusDot tone={statusToneForTarget(selectedTarget)} size={8} />
              <div>
                <strong>{selectedTarget.label}</strong>
                <span>{selectedTarget.detail || selectedTarget.id}</span>
              </div>
              <span class="terminal-selected-tags">
                <Tag tone={selectedTarget.online ? "online" : "idle"} label={selectedTarget.online ? "ONLINE" : "OFFLINE"} boxed dot />
                <Tag tone={selectedTarget.native ? "accent" : "info"} label={selectedTarget.native ? "NATIVE" : "DEVICE"} boxed />
              </span>
            </div>
            <TargetInventory
              targets={targetOptions}
              loading={targets.resource.isLoading}
              error={targetLoadError}
              empty={targetEmpty}
              offline={!connected}
              selectedId={selectedTarget.id}
              disabled={command.isPending}
              onSelect={setSelectedTargetId}
              onRetry={() => {
                void targets.refetch();
              }}
            />
            <CommandHistory
              history={history}
              pending={command.isPending}
              canRerun={canExecuteCommand}
              onLoad={loadHistoryItem}
              onRerun={rerunHistoryItem}
              onClear={() => setHistory([])}
            />
          </div>
        </section>

        <section class="terminal-panel terminal-command-panel" aria-label="Terminal command runner">
          <SectionHeader title="COMMAND" meta={command.isPending ? "EXECUTING" : "READY"} divider />
          <div class="terminal-panel-body">
            {!connected ? (
              <TerminalInlineState
                kind="offline"
                title="Gateway offline"
                detail="Command execution is disabled until the gateway reconnects."
              />
            ) : null}
            <div class="terminal-run-context">
              <div class="terminal-run-target">
                <Icon name={selectedTarget.native ? "terminal" : "computer"} size={18} />
                <div>
                  <span>TARGET</span>
                  <strong>{selectedTarget.label}</strong>
                  <small>{selectedTarget.detail || selectedTarget.id}</small>
                </div>
              </div>
              <div class="terminal-run-tags">
                <Tag tone={selectedTarget.online ? "online" : "idle"} label={selectedTarget.online ? "ONLINE" : "OFFLINE"} boxed dot />
                <Tag tone={selectedTarget.native ? "accent" : "info"} label={selectedTarget.native ? "NATIVE" : "DEVICE"} boxed />
                <Tag tone={background ? "update" : "idle"} label={background ? "BACKGROUND" : "FOREGROUND"} boxed />
              </div>
            </div>
            <div class="terminal-command-grid">
              <label class="terminal-field">
                <span>CWD</span>
                <input
                  class="terminal-input"
                  value={cwd}
                  placeholder="Optional working directory"
                  disabled={command.isPending}
                  spellcheck={false}
                  onInput={(event) => setCwd(event.currentTarget.value)}
                />
              </label>
              <label class="terminal-field">
                <span>TIMEOUT MS</span>
                <input
                  class="terminal-input"
                  value={timeoutMs}
                  inputMode="numeric"
                  placeholder="Default"
                  disabled={command.isPending}
                  spellcheck={false}
                  onInput={(event) => setTimeoutMs(event.currentTarget.value)}
                />
              </label>
              <label class="terminal-field">
                <span>YIELD MS</span>
                <input
                  class="terminal-input"
                  value={yieldMs}
                  inputMode="numeric"
                  placeholder="Default"
                  disabled={command.isPending || !background}
                  spellcheck={false}
                  onInput={(event) => setYieldMs(event.currentTarget.value)}
                />
              </label>
            </div>
            <label class="terminal-toggle-row">
              <input
                type="checkbox"
                checked={background}
                disabled={command.isPending}
                onInput={(event) => setBackground(event.currentTarget.checked)}
              />
              <span>BACKGROUND</span>
            </label>
            <label class="terminal-field">
              <span>COMMAND</span>
              <textarea
                class="terminal-command-input"
                value={commandInput}
                placeholder="Type a shell command"
                rows={4}
                disabled={command.isPending}
                spellcheck={false}
                onInput={(event) => setCommandInput(event.currentTarget.value)}
                onKeyDown={handleCommandKeyDown}
              />
            </label>
            <div class="terminal-actions">
              <Button variant="primary" label={command.isPending ? "RUNNING" : "RUN"} disabled={runDisabled} onClick={runCommand} />
              <Button
                variant="secondary"
                label="CLEAR OUTPUT"
                disabled={command.isPending || (!command.data && !command.error)}
                onClick={() => command.reset()}
              />
              <span class="terminal-run-status">
                <StatusDot
                  tone={!connected || selectedTargetOffline ? "idle" : command.isPending ? "live" : command.error ? "error" : "online"}
                  size={8}
                />
                <span>
                  {!connected
                    ? "OFFLINE"
                    : selectedTargetOffline
                      ? "TARGET OFFLINE"
                      : command.isPending
                        ? "EXECUTING"
                        : commandIsBlank
                          ? "WAITING FOR COMMAND"
                          : "READY"}
                </span>
              </span>
            </div>
          </div>
        </section>

        <section class="terminal-panel terminal-output-panel" aria-label="Terminal output">
          <SectionHeader title="OUTPUT" meta={outputMeta} divider />
          <div class="terminal-output">
            <CommandOutput
              entry={command.data}
              pending={command.isPending}
              error={command.error}
              streamFilter={streamFilter}
              pollDisabled={!connected || command.isPending}
              onStreamFilterChange={setStreamFilter}
              onPollSession={pollSession}
            />
          </div>
        </section>
      </div>
    </ConsolePage>
  );
}
