import { forwardRef } from "preact/compat";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "preact/hooks";
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
  onSubmit: (text: string) => void | boolean | Promise<void | boolean>;
  allowEmpty?: boolean;
  onFiles?: (files: File[]) => void;
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

export type PromptLineHandle = {
  disabled: boolean;
  setValue(value: string): void;
  focus(): void;
  blur(): void;
  submit(): void;
};

/**
 * One line: a place chip and an input. Plain words go to the ship. Text that
 * starts with `$` runs on the place directly, and while it does the chip shows
 * the working directory instead of the place, so the change itself is the
 * feedback; the `$` the person typed is the sigil. An offline place says so in
 * the chip and keeps taking words.
 */
// The prompt grows from that first line as text wraps, up to a scrollable height.
export const PromptLine = forwardRef<PromptLineHandle, PromptLineProps>(function PromptLine({ place, dir, placeholder, disabled, onSubmit, allowEmpty, onFiles, onPlace, onHistory, autoFocus, onFocusChange, onInput, onKeyIntercept }, ref) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLSpanElement>(null);
  const mirrorRef = useRef<HTMLSpanElement>(null);
  const [command, setCommand] = useState(false);
  const revision = useRef(0);
  const submitting = useRef(false);
  const autoFocusHandled = useRef(false);
  /* the block caret: the input's own caret is hidden and a block is drawn where it is, measured off a mirror of the text before it */
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState({ x: 0, y: 0, visible: true });
  const measure = useCallback((reveal = false) => {
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    const field = fieldRef.current;
    const chip = chipRef.current;
    if (!input || !mirror || !field || !chip) return;
    field.style.setProperty("--prompt-indent", `${chip.offsetWidth + 12}px`);
    const style = getComputedStyle(input);
    const fontSize = parseFloat(style.fontSize);
    const lineHeight = parseFloat(style.lineHeight);
    field.style.setProperty("--prompt-font-size", style.fontSize);
    // Form controls can have a different computed font size on narrow screens.
    mirror.style.font = style.font;
    mirror.style.letterSpacing = style.letterSpacing;
    mirror.style.textIndent = style.textIndent;
    const at = input.selectionStart;
    const marker = document.createElement("span");
    // Keep the suffix in the mirror: word wrapping depends on text after the caret too.
    marker.textContent = input.value.slice(at) || "\u200b";
    mirror.style.width = `${input.clientWidth}px`;
    mirror.replaceChildren(document.createTextNode(input.value.slice(0, at)), marker);
    const height = `${mirror.offsetHeight}px`;
    if (input.style.height !== height) input.style.height = height;
    const lineTop = Math.round(marker.offsetTop / lineHeight) * lineHeight;
    if (reveal && document.activeElement === input && input.selectionStart === input.selectionEnd) {
      const bottom = lineTop + lineHeight;
      if (lineTop < input.scrollTop) input.scrollTop = lineTop;
      else if (bottom > input.scrollTop + input.clientHeight) input.scrollTop = bottom - input.clientHeight;
    }
    chip.style.top = `${Math.max(0, (lineHeight - chip.offsetHeight) / 2)}px`;
    chip.style.transform = `translateY(${-input.scrollTop}px)`;
    const next = {
      x: marker.offsetLeft - input.scrollLeft,
      y: lineTop + (lineHeight - fontSize) / 2 - input.scrollTop,
      visible: input.selectionStart === input.selectionEnd,
    };
    setCaret((current) => current.x === next.x && current.y === next.y && current.visible === next.visible ? current : next);
  }, []);
  useLayoutEffect(() => {
    measure(true);
    const input = inputRef.current;
    if (input && document.activeElement === input) setFocused(true);
  }, [measure, disabled]);
  useLayoutEffect(() => {
    if (!autoFocus || disabled || autoFocusHandled.current) return;
    autoFocusHandled.current = true;
    if (document.activeElement === document.body || document.activeElement === null) inputRef.current?.focus();
  }, [autoFocus, disabled]);
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const refresh = () => measure(true);
    const observer = new ResizeObserver(refresh);
    observer.observe(field);
    if (chipRef.current) observer.observe(chipRef.current);
    document.fonts.addEventListener("loadingdone", refresh);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", refresh);
    };
  }, [measure]);
  const read = (): string => inputRef.current?.value ?? "";
  const changed = (): void => {
    revision.current++;
    const value = read();
    setCommand(value.startsWith("$"));
    onInput?.(value);
    measure(true);
  };
  useImperativeHandle(ref, () => ({
    disabled: Boolean(disabled),
    setValue(value) {
      if (!inputRef.current) return;
      inputRef.current.value = value;
      changed();
    },
    focus: () => inputRef.current?.focus(),
    blur: () => inputRef.current?.blur(),
    submit: () => { void send(); },
  }));
  const send = async () => {
    const input = inputRef.current;
    if (!input || disabled || submitting.current) return;
    const text = input.value.trim();
    if (!text && !allowEmpty) return;
    const sentRevision = revision.current;
    submitting.current = true;
    try {
      const accepted = await onSubmit(text);
      if (accepted !== false && inputRef.current === input && revision.current === sentRevision) {
        input.value = "";
        changed();
      }
    } finally { submitting.current = false; }
  };
  const submit = (event: JSX.TargetedEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const input = inputRef.current;
    if (!input || event.isComposing) return;
    if (onKeyIntercept?.(event, input.value)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
      return;
    }
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
      <span class="field" ref={fieldRef}>
        <button ref={chipRef} type="button" class="chip" onClick={onPlace} title={chipTitle} aria-label={chipTitle} tabIndex={-1}>
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
        <textarea
          ref={inputRef}
          rows={1}
          placeholder={placeholder}
          aria-label="Prompt"
          spellcheck={false}
          disabled={disabled}
          onKeyDown={onKeyDown}
          onKeyUp={() => measure(true)}
          onClick={() => measure(true)}
          onSelect={() => measure(true)}
          onScroll={() => measure()}
          onInput={changed}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (onFiles && files.length > 0) { event.preventDefault(); onFiles(files); }
          }}
          onFocus={() => {
            setFocused(true);
            measure(true);
            onFocusChange?.(true);
          }}
          onBlur={() => {
            setFocused(false);
            onFocusChange?.(false);
          }}
        />
        <span class="mirror" ref={mirrorRef} aria-hidden="true" />
        {focused && !disabled && caret.visible ? <span class="block-caret" style={{ transform: `translate(${caret.x}px, ${caret.y}px)` }} aria-hidden="true" /> : null}
      </span>
    </form>
  );
});
