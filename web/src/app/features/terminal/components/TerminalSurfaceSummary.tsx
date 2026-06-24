import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ListRow } from "../../../components/ui/ListRow";
import { Spinner } from "../../../components/ui/Spinner";
import { Surface } from "../../../components/ui/Surface";
import { TextArea } from "../../../components/ui/TextArea";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { ConsolePage } from "../../gsv-console/components/ConsolePageTemplate";
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

type TerminalLine =
  | {
      id: string;
      kind: "command";
      command: string;
      prompt: string;
    }
  | {
      id: string;
      kind: "output" | "error" | "system";
      text: string;
    };

const MAX_HISTORY_ITEMS = 200;
const MAX_LINES = 260;
const NATIVE_TARGET_ID = "gsv";

function nowId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function appendLines(lines: readonly TerminalLine[], next: readonly TerminalLine[]): TerminalLine[] {
  return [...lines, ...next].slice(-MAX_LINES);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : error ? String(error) : "Command failed.";
}

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
        detail: [target.platform, target.description].filter(Boolean).join(" / "),
        online: target.online,
        native: false,
      })),
  ];
}

function promptText(username: string, host: string): string {
  return `${username.trim() || "user"}@${host} $`;
}

function targetSubLabel(target: TargetOption): string {
  return [target.id, target.detail].filter(Boolean).join(" / ");
}

function targetTag(target: TargetOption): string {
  if (target.native) return "NATIVE";
  return target.detail.split(" / ")[0]?.trim().toUpperCase() || "MACHINE";
}

function TerminalLineView({ line }: { line: TerminalLine }) {
  if (line.kind === "command") {
    return (
      <div class="terminal-line is-command">
        <span class="terminal-line-prompt">{line.prompt}</span>
        <span class="terminal-line-command">{line.command}</span>
      </div>
    );
  }

  return (
    <div class={`terminal-line is-${line.kind}`}>
      <pre>{line.text}</pre>
    </div>
  );
}

export function TerminalSurfaceSummary() {
  const { connected, status } = useGateway();
  const command = useTerminalCommandMutation();
  const targets = useTerminalTargets(connected);
  const [selectedTargetId, setSelectedTargetId] = useState(NATIVE_TARGET_ID);
  const [hostPickerOpen, setHostPickerOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const screenRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const hostButtonRef = useRef<HTMLButtonElement>(null);
  const hostPickerRef = useRef<HTMLDivElement>(null);
  const username = status.username ?? "user";
  const targetOptions = useMemo(
    () => buildTargetOptions(targets.targets, connected),
    [connected, targets.targets],
  );
  const selectedTarget = targetOptions.find((target) => target.id === selectedTargetId) ?? targetOptions[0];
  const prompt = promptText(username, selectedTarget.id);

  useEffect(() => {
    if (!targetOptions.some((target) => target.id === selectedTargetId)) {
      setSelectedTargetId(NATIVE_TARGET_ID);
    }
  }, [selectedTargetId, targetOptions]);

  useEffect(() => {
    if (!hostPickerOpen) {
      return;
    }
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target) {
        return;
      }
      if (hostPickerRef.current?.contains(target) || hostButtonRef.current?.contains(target)) {
        return;
      }
      setHostPickerOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setHostPickerOpen(false);
        window.requestAnimationFrame(focusInput);
      }
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [hostPickerOpen]);

  useEffect(() => {
    const node = screenRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [lines, command.isPending]);

  const focusInput = () => {
    inputRef.current?.focus();
  };

  const addSystemLine = (text: string) => {
    setLines((current) => appendLines(current, [{
      id: nowId("system"),
      kind: "system",
      text,
    }]));
  };

  const addResultLines = (entry: TerminalTranscriptEntry) => {
    const nextLines: TerminalLine[] = [];
    if (entry.stdout) {
      nextLines.push({
        id: nowId("stdout"),
        kind: "output",
        text: entry.stdout,
      });
    }
    if (entry.stderr) {
      nextLines.push({
        id: nowId("stderr"),
        kind: "error",
        text: entry.stderr,
      });
    }
    if (nextLines.length > 0) {
      setLines((current) => appendLines(current, nextLines));
    }
  };

  const rememberHistory = (rawCommand: string) => {
    if (!rawCommand.trim()) {
      return;
    }
    setHistory((items) => {
      const withoutDuplicateTail = items[items.length - 1] === rawCommand ? items : [...items, rawCommand];
      return withoutDuplicateTail.slice(-MAX_HISTORY_ITEMS);
    });
    setHistoryCursor(null);
  };

  const runShellCommand = async (rawCommand: string) => {
    if (!connected) {
      addSystemLine("Gateway is offline.");
      return;
    }
    if (!selectedTarget.online) {
      addSystemLine(`${selectedTarget.id}: host offline.`);
      return;
    }

    try {
      const entry = await command.mutateAsync({
        input: rawCommand,
        target: selectedTarget.id,
      });
      addResultLines(entry);
    } catch (error) {
      addSystemLine(errorText(error));
    } finally {
      window.requestAnimationFrame(focusInput);
    }
  };

  const selectTarget = (target: TargetOption) => {
    if (!target.online) {
      return;
    }
    setSelectedTargetId(target.id);
    setHostPickerOpen(false);
    window.requestAnimationFrame(focusInput);
  };

  const submitCommand = () => {
    const rawCommand = draft.trim();
    if (!rawCommand || command.isPending) {
      return;
    }

    setLines((current) => appendLines(current, [{
      id: nowId("command"),
      kind: "command",
      command: rawCommand,
      prompt,
    }]));
    rememberHistory(rawCommand);
    setDraft("");
    window.requestAnimationFrame(focusInput);
    void runShellCommand(rawCommand);
  };

  const handleKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitCommand();
      return;
    }
    if (event.key === "ArrowUp" && !event.shiftKey && draft.split(/\r\n|\r|\n/).length === 1) {
      if (history.length === 0) {
        return;
      }
      event.preventDefault();
      const nextCursor = historyCursor === null ? history.length - 1 : Math.max(0, historyCursor - 1);
      setHistoryCursor(nextCursor);
      setDraft(history[nextCursor] ?? "");
      return;
    }
    if (event.key === "ArrowDown" && !event.shiftKey && historyCursor !== null) {
      event.preventDefault();
      const nextCursor = historyCursor + 1;
      if (nextCursor >= history.length) {
        setHistoryCursor(null);
        setDraft("");
      } else {
        setHistoryCursor(nextCursor);
        setDraft(history[nextCursor] ?? "");
      }
      return;
    }
    if (event.key.toLowerCase() === "l" && event.ctrlKey) {
      event.preventDefault();
      setLines([]);
    }
  };

  return (
    <ConsolePage flush className="terminal-console-page">
      <div class="terminal-page-frame">
        <Surface class="terminal-shell" level={2} onClick={focusInput}>
          <div class="terminal-shell-screen" ref={screenRef}>
            {lines.map((line) => <TerminalLineView key={line.id} line={line} />)}
            {command.isPending ? (
              <div class="terminal-line is-system terminal-running">
                <Spinner size={13} />
              </div>
            ) : null}
          </div>

          <form
            class="terminal-composer"
            onSubmit={(event) => {
              event.preventDefault();
              submitCommand();
            }}
          >
            <span class="terminal-composer-prompt">
              <span>{(username.trim() || "user")}@</span>
              <button
                ref={hostButtonRef}
                type="button"
                class="terminal-host-button"
                aria-haspopup="listbox"
                aria-expanded={hostPickerOpen}
                onClick={(event) => {
                  event.stopPropagation();
                  setHostPickerOpen((open) => !open);
                }}
              >
                {selectedTarget.id}
              </button>
              <span>&nbsp;$</span>
              {hostPickerOpen ? (
                <div
                  ref={hostPickerRef}
                  class="terminal-host-popover"
                  role="listbox"
                  aria-label="Terminal host"
                  onClick={(event) => event.stopPropagation()}
                >
                  <Surface class="terminal-host-menu" level={2}>
                    <div class="terminal-host-menu-head">HOST</div>
                    <div class="terminal-host-menu-list">
                      {targetOptions.map((target) => (
                        <ListRow
                          key={target.id}
                          label={target.label}
                          sub={targetSubLabel(target)}
                          status={target.online ? "online" : "idle"}
                          statusLabel={target.online ? "ONLINE" : "OFFLINE"}
                          tag={targetTag(target)}
                          tagTone={target.native ? "accent" : "info"}
                          active={target.id === selectedTarget.id}
                          onClick={target.online ? () => selectTarget(target) : undefined}
                        />
                      ))}
                      {targets.resource.isLoading ? (
                        <div class="terminal-host-state">
                          <Spinner size={13} />
                          <span>Loading machines</span>
                        </div>
                      ) : null}
                      {targets.resource.isError ? (
                        <div class="terminal-host-state is-error">
                          {targets.resource.errorText || "Unable to load machines."}
                        </div>
                      ) : null}
                    </div>
                  </Surface>
                </div>
              ) : null}
            </span>
            <TextArea
              value={draft}
              rows={1}
              size="small"
              label=""
              placeholder=""
              disabled={!connected}
              readonly={command.isPending}
              onChange={setDraft}
              textareaProps={{
                ref: inputRef,
                onKeyDown: handleKeyDown,
                "aria-label": "Terminal command input",
              }}
            />
          </form>
        </Surface>
      </div>
    </ConsolePage>
  );
}
