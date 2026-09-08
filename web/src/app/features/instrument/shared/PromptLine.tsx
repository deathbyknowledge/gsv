import { useRef, useState } from "preact/hooks";
import type { JSX } from "preact";

export type PromptPlace = {
  id: string;
  /** What the person calls it: the target's label, or "your cloud home". */
  label: string;
  online: boolean;
};

export type PromptLineProps = {
  /** Where the prompt points. Shown as a chip; it is the target, not a shell prompt. */
  place: PromptPlace;
  /** The working directory a command runs in on that place, already shortened for display. */
  dir: string;
  placeholder: string;
  disabled?: boolean;
  onSubmit: (text: string) => void;
  /** Called when the chip is pressed, to change the place. */
  onPlace?: () => void;
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

/**
 * One line: a place chip and an input. Plain words go to the ship. Text that
 * starts with `$` runs on the place directly, and while it does the chip shows
 * the working directory instead of the place, so the change itself is the
 * feedback; the `$` the person typed is the sigil. An offline place says so in
 * the chip and keeps taking words.
 */
export function PromptLine({ place, dir, placeholder, disabled, onSubmit, onPlace, onHistory, autoFocus, onFocusChange, onInput, onKeyIntercept }: PromptLineProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [command, setCommand] = useState(false);
  const read = (): string => inputRef.current?.value ?? "";
  const changed = (): void => {
    const value = read();
    setCommand(value.startsWith("$"));
    onInput?.(value);
  };
  const submit = (event: JSX.TargetedEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = inputRef.current;
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    changed();
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
  const chipTitle = command ? `runs on ${place.label} in ${dir}` : place.online ? `on ${place.label}; press to change` : `${place.label} is offline; press to change`;
  return (
    <form class={`prompt-line${command ? " is-command" : ""}${place.online ? "" : " is-offline"}`} onSubmit={submit} autocomplete="off">
      <button type="button" class="chip" onClick={onPlace} title={chipTitle} aria-label={chipTitle} tabIndex={-1}>
        {command ? (
          <span class="dir">{dir}</span>
        ) : (
          <>
            <span class={`dot${place.online ? " is-on" : ""}`} aria-hidden="true" />
            <span class="label">{place.label}</span>
            {place.online ? null : <span class="state">offline</span>}
          </>
        )}
      </button>
      <input
        ref={inputRef}
        type="text"
        placeholder={placeholder}
        aria-label="Prompt"
        spellcheck={false}
        disabled={disabled}
        onKeyDown={onKeyDown}
        onInput={changed}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
        autoFocus={autoFocus}
      />
    </form>
  );
}
