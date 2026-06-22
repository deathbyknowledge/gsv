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
import { ConsolePage, ConsolePageState } from "../../gsv-console/components/ConsolePageTemplate";
import type { TerminalTarget, TerminalTranscriptEntry } from "../domain/models";
import { useTerminalCommandMutation, useTerminalTargets } from "../hooks/useTerminalQueries";
import "./TerminalSurfaceSummary.css";

type TargetOption = {
  id: string;
  label: string;
  detail: string;
  online: boolean;
  native: boolean;
};

const NATIVE_TARGET_ID = "gsv";

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

function resultTone(entry: TerminalTranscriptEntry): TagTone {
  if (entry.status === "failed") return "error";
  if (entry.status === "running") return "update";
  return "online";
}

function resultLabel(entry: TerminalTranscriptEntry): string {
  if (entry.status === "running") return "RUNNING";
  if (entry.status === "failed") return "FAILED";
  return "COMPLETED";
}

function resultMeta(entry: TerminalTranscriptEntry): string {
  const parts = [
    entry.exitCode === null ? "" : `EXIT ${entry.exitCode}`,
    entry.sessionId ? `SESSION ${entry.sessionId}` : "",
    entry.truncated ? "TRUNCATED" : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function formatDuration(startedAt: number, completedAt: number): string {
  const duration = Math.max(0, completedAt - startedAt);
  return `${duration}ms`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : "Command failed.";
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
  onRetry,
}: {
  targets: readonly TerminalTarget[];
  loading: boolean;
  error: string;
  empty: boolean;
  offline: boolean;
  onRetry: () => void;
}) {
  if (offline) {
    return (
      <TerminalInlineState
        kind="offline"
        title="Gateway offline"
        detail="Reconnect to refresh targets or run commands."
      />
    );
  }
  if (loading) {
    return (
      <TerminalInlineState
        kind="loading"
        title="Loading targets"
        detail="Reading command targets from the gateway."
      />
    );
  }
  if (error) {
    return (
      <TerminalInlineState
        kind="error"
        title="Target load failed"
        detail={error}
        action={<Button variant="secondary" label="RETRY" onClick={onRetry} />}
      />
    );
  }
  if (empty) {
    return (
      <TerminalInlineState
        kind="empty"
        title="No remote targets"
        detail="The native GSV shell is still available."
      />
    );
  }

  return (
    <div class="terminal-target-list" aria-label="Command targets">
      {targets.map((target) => (
        <div class="terminal-target-row" key={target.id}>
          <span class="terminal-target-icon">
            <Icon name="computer" size={16} />
          </span>
          <div class="terminal-target-copy">
            <strong>{target.label}</strong>
            <span>{[target.id, target.platform, target.description].filter(Boolean).join(" · ")}</span>
          </div>
          <span class="terminal-target-state">
            <StatusDot tone={statusToneForTarget(target)} size={7} />
            <span>{target.online ? "ONLINE" : "OFFLINE"}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function CommandOutput({
  entry,
  pending,
  error,
}: {
  entry: TerminalTranscriptEntry | undefined;
  pending: boolean;
  error: unknown;
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
  const meta = resultMeta(entry);

  return (
    <div class="terminal-transcript" aria-live="polite">
      <div class="terminal-transcript-header">
        <div>
          <span>{entry.target}</span>
          <strong>{entry.command}</strong>
          {entry.cwd ? <small>{entry.cwd}</small> : null}
        </div>
        <div class="terminal-transcript-tags">
          <Tag tone={resultTone(entry)} label={resultLabel(entry)} boxed />
          {meta ? <Tag tone="idle" label={meta} boxed /> : null}
          <Tag tone="info" label={formatDuration(entry.startedAt, entry.completedAt)} boxed />
        </div>
      </div>
      {!hasStdout && !hasStderr ? (
        <div class="terminal-output-state is-compact">
          <span>Command completed with no output</span>
        </div>
      ) : null}
      {hasStdout ? (
        <section class="terminal-stream">
          <span>STDOUT</span>
          <pre>{entry.stdout}</pre>
        </section>
      ) : null}
      {hasStderr ? (
        <section class="terminal-stream is-error">
          <span>STDERR</span>
          <pre>{entry.stderr}</pre>
        </section>
      ) : null}
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
  const [commandInput, setCommandInput] = useState("");

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
  const commandIsBlank = commandInput.trim().length === 0;
  const runDisabled = !connected || selectedTargetOffline || command.isPending || commandIsBlank;
  const outputMeta = command.isPending
    ? "RUNNING"
    : command.data
      ? resultLabel(command.data)
      : command.error
        ? "ERROR"
        : "IDLE";

  useEffect(() => {
    if (!targetOptions.some((option) => option.id === selectedTargetId)) {
      setSelectedTargetId(NATIVE_TARGET_ID);
    }
  }, [selectedTargetId, targetOptions]);

  const runCommand = () => {
    if (runDisabled) {
      return;
    }
    command.mutate({
      input: commandInput,
      target: selectedTarget.id,
      cwd,
      timeoutMs,
    });
  };

  const handleCommandKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      runCommand();
    }
  };

  if (!connected && targets.resource.data === null) {
    return (
      <ConsolePage>
        <ConsolePageState kind="offline" detail="CONNECTION REQUIRED" />
      </ConsolePage>
    );
  }

  return (
    <ConsolePage>
      <div class="terminal-surface">
        <section class="terminal-panel terminal-target-panel" aria-label="Terminal targets">
          <SectionHeader
            title="COMMAND TARGETS"
            meta={`${targets.targets.filter((target) => target.online).length}/${targets.targets.length} ONLINE`}
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
            </div>
            <TargetInventory
              targets={targets.targets}
              loading={targets.resource.isLoading}
              error={targetLoadError}
              empty={targetEmpty}
              offline={!connected}
              onRetry={() => {
                void targets.refetch();
              }}
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
            </div>
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
            <CommandOutput entry={command.data} pending={command.isPending} error={command.error} />
          </div>
        </section>
      </div>
    </ConsolePage>
  );
}
