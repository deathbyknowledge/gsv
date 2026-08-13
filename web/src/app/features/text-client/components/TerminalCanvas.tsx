import type { ComponentChildren, JSX } from "preact";
import "../textClient.css";

export type TerminalLineKind = "command" | "output" | "system" | "error";

export interface TerminalLine {
  id: string;
  text: string;
  kind?: TerminalLineKind;
  prompt?: string;
}

export interface TerminalCanvasProps {
  lines: readonly TerminalLine[];
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  prompt?: string;
  placeholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  busy?: boolean;
  autoFocus?: boolean;
  ariaLabel?: string;
  submitLabel?: string;
  footer?: ComponentChildren;
  className?: string;
}

function TerminalLineView({ line }: { line: TerminalLine }) {
  const kind = line.kind ?? "output";

  if (kind === "command") {
    return (
      <div class="text-client-terminal-line is-command">
        {line.prompt ? (
          <span class="text-client-terminal-line-prompt">{line.prompt}</span>
        ) : null}
        <span class="text-client-terminal-line-text">{line.text}</span>
      </div>
    );
  }

  return (
    <div class={`text-client-terminal-line is-${kind}`}>
      <pre>{line.text}</pre>
    </div>
  );
}

/** Controlled terminal transcript and composer with no execution dependencies. */
export function TerminalCanvas({
  lines,
  value,
  onValueChange,
  onSubmit,
  prompt = ">",
  placeholder = "Type a command",
  emptyMessage = "Ready.",
  disabled = false,
  busy = false,
  autoFocus = false,
  ariaLabel = "Terminal",
  submitLabel = "Run command",
  footer,
  className,
}: TerminalCanvasProps) {
  const classes = ["text-client-terminal", className].filter(Boolean).join(" ");
  const inputDisabled = disabled || busy;

  const handleKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
      return;
    }
    event.preventDefault();
    onSubmit();
  };

  const handleSubmit = (event: JSX.TargetedSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <section class={classes} aria-label={ariaLabel} aria-busy={busy}>
      <div
        class="text-client-terminal-transcript"
        role="log"
        tabIndex={0}
        aria-label="Terminal transcript"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {lines.length > 0 ? (
          lines.map((line) => <TerminalLineView key={line.id} line={line} />)
        ) : (
          <p class="text-client-terminal-empty">{emptyMessage}</p>
        )}
        {busy ? (
          <p class="text-client-terminal-running">
            <span aria-hidden="true" />
            Running
          </p>
        ) : null}
      </div>

      {footer ? <div class="text-client-terminal-footer">{footer}</div> : null}

      <form class="text-client-terminal-composer" onSubmit={handleSubmit}>
        <span class="text-client-terminal-prompt" aria-hidden="true">{prompt}</span>
        <textarea
          class="text-client-terminal-input"
          aria-label="Command"
          rows={1}
          value={value}
          placeholder={placeholder}
          disabled={inputDisabled}
          autofocus={autoFocus}
          spellcheck={false}
          autocapitalize="off"
          autocomplete="off"
          onInput={(event) => onValueChange(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="submit"
          class="text-client-terminal-submit"
          aria-label={submitLabel}
          title={submitLabel}
          disabled={inputDisabled}
        >
          <span aria-hidden="true">↵</span>
        </button>
      </form>
    </section>
  );
}
