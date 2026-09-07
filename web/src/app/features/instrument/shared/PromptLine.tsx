import { useRef } from "preact/hooks";
import type { JSX } from "preact";

export type PromptLineProps = {
  /** Who is typing: the signed-in principal's username. */
  who: string;
  /** Where the prompt points: a target id. Shown bold, in the target color. */
  where: string;
  /** The working directory on that target, already shortened for display. */
  dir: string;
  placeholder: string;
  disabled?: boolean;
  onSubmit: (text: string) => void;
  /** Called on ArrowUp / ArrowDown with the input empty, for history browsing. */
  onHistory?: (direction: -1 | 1) => void;
  autoFocus?: boolean;
  /** Called when the input gains or loses focus, so the surface can enter and leave browse mode. */
  onFocusChange?: (focused: boolean) => void;
  /** Called with the current text on every keystroke, for pickers that follow the input. */
  onInput?: (value: string) => void;
  /** Runs before the line's own key handling; return true to consume the key. */
  onKeyIntercept?: (event: KeyboardEvent, value: string) => boolean;
};

/** The TUI's prompt line: `who@where dir $` and one input. A sentence goes to the ship; `$` runs directly. */
export function PromptLine({ who, where, dir, placeholder, disabled, onSubmit, onHistory, autoFocus, onFocusChange, onInput, onKeyIntercept }: PromptLineProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = (event: JSX.TargetedEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = inputRef.current;
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    onInput?.("");
    onSubmit(text);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const input = inputRef.current;
    if (!input) return;
    if (onKeyIntercept?.(event, input.value)) return;
    if (event.key === "Escape") {
      // Escape leaves the prompt, the way the TUI drops into browse mode; shortcuts work from there.
      event.preventDefault();
      input.blur();
      return;
    }
    if (!onHistory || input.value !== "") return;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onHistory(-1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onHistory(1);
    }
  };
  return (
    <form class="prompt-line" onSubmit={submit} autocomplete="off">
      <span class="who">{who}</span>
      <span class="at">@</span>
      <span class="where">{where}</span>
      <span class="dir">{dir}</span>
      <span class="sigil">$</span>
      <input
        ref={inputRef}
        type="text"
        placeholder={placeholder}
        aria-label="Prompt"
        spellcheck={false}
        disabled={disabled}
        onKeyDown={onKeyDown}
        onInput={() => onInput?.(inputRef.current?.value ?? "")}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
        autoFocus={autoFocus}
      />
    </form>
  );
}
