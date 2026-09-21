import { forwardRef } from "preact/compat";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { useViewActive } from "../../../services/navigation/ViewActivity";

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
  /** A native composer can finalize its current segment before ordinary submission. */
  interceptSubmit?: () => boolean;
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
  /** The place chip, so the picker it opens can tell a press on it from one outside. */
  chip: HTMLButtonElement | null;
  setValue(value: string, caret?: number): void;
  selection(): { value: string; start: number; end: number };
  /** Add text after what is already there and start editing; how a paste from outside the prompt lands. */
  append(text: string): void;
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
export const PromptLine = forwardRef<PromptLineHandle, PromptLineProps>(function PromptLine({ place, dir, placeholder, disabled, onSubmit, allowEmpty, interceptSubmit, onFiles, onPlace, onHistory, autoFocus, onFocusChange, onInput, onKeyIntercept }, ref) {
  const active = useViewActive();
  const activeRef = useRef(active);
  activeRef.current = active;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLSpanElement>(null);
  const mirrorRef = useRef<HTMLSpanElement>(null);
  const mirrorText = useRef<{ before: Text; marker: HTMLSpanElement; after: Text } | null>(null);
  const caretRef = useRef<HTMLSpanElement>(null);
  const [command, setCommand] = useState(false);
  const revision = useRef(0);
  const submitting = useRef(false);
  const autoFocusHandled = useRef(false);
  /* the block caret: the input's own caret is hidden and a block is drawn where it is, measured off a mirror of the text before it */
  const measureFrame = useRef(0);
  const revealPending = useRef(false);
  const caretTimings = useRef<{ kind: "input" | "cursor"; start: number }[]>([]);
  const recordCaretInput = (event: Event, kind: "input" | "cursor") => {
    if (event.timeStamp >= 0 && event.timeStamp <= performance.now() && caretTimings.current.length < 64) {
      caretTimings.current.push({ kind, start: event.timeStamp });
    }
  };
  const metrics = useRef<{ fontSize: number; lineHeight: number } | null>(null);
  const measured = useRef<{ value: string; start: number; end: number; width: number; top: number; left: number; reveal: boolean; focused: boolean } | null>(null);
  const measure = useCallback((reveal = false) => {
    if (!activeRef.current) return;
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    const field = fieldRef.current;
    const chip = chipRef.current;
    const caret = caretRef.current;
    if (!input || !mirror || !field || !chip || !caret) return;
    if (!metrics.current) {
      field.style.setProperty("--prompt-indent", `${chip.offsetWidth + 12}px`);
      const style = getComputedStyle(input);
      metrics.current = { fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight) };
      field.style.setProperty("--prompt-font-size", style.fontSize);
      // Form controls can have a different computed font size on narrow screens.
      mirror.style.font = style.font;
      mirror.style.letterSpacing = style.letterSpacing;
      mirror.style.textIndent = style.textIndent;
      chip.style.top = `${Math.max(0, (metrics.current.lineHeight - chip.offsetHeight) / 2)}px`;
      measured.current = null;
    }
    const { fontSize, lineHeight } = metrics.current;
    const width = input.clientWidth;
    const at = input.selectionStart;
    const focused = document.activeElement === input && !input.disabled;
    const previous = measured.current;
    if (previous && previous.value === input.value && previous.start === at && previous.end === input.selectionEnd
      && previous.width === width && previous.top === input.scrollTop && previous.left === input.scrollLeft
      && previous.focused === focused
      && (!reveal || previous.reveal)) return;
    if (!mirrorText.current) {
      const before = document.createTextNode("");
      const marker = document.createElement("span");
      const after = document.createTextNode("");
      marker.append(after);
      mirror.replaceChildren(before, marker);
      mirrorText.current = { before, marker, after };
    }
    const { before, marker, after } = mirrorText.current;
    // Keep the suffix in the mirror: word wrapping depends on text after the caret too.
    if (!previous || previous.value !== input.value || previous.start !== at) {
      before.data = input.value.slice(0, at);
      after.data = input.value.slice(at) || "\u200b";
    }
    if (previous?.width !== width) mirror.style.width = `${width}px`;
    const lineTop = Math.round(marker.offsetTop / lineHeight) * lineHeight;
    const left = marker.offsetLeft;
    if (!previous || previous.value !== input.value || previous.width !== width) {
      const height = `${mirror.offsetHeight}px`;
      if (input.style.height !== height) input.style.height = height;
    }
    if (reveal && focused && input.selectionStart === input.selectionEnd) {
      const bottom = lineTop + lineHeight;
      if (lineTop < input.scrollTop) input.scrollTop = lineTop;
      else if (bottom > input.scrollTop + input.clientHeight) input.scrollTop = bottom - input.clientHeight;
    }
    chip.style.transform = `translateY(${-input.scrollTop}px)`;
    const visible = focused && input.selectionStart === input.selectionEnd;
    // Cursor geometry belongs to this measurement, without a component update after the frame callback.
    caret.style.transform = `translate(${left - input.scrollLeft}px, ${lineTop + (lineHeight - fontSize) / 2 - input.scrollTop}px)`;
    caret.style.visibility = visible ? "visible" : "hidden";
    if (visible && (!previous?.focused || previous.value !== input.value || previous.start !== at || previous.end !== input.selectionEnd)) {
      for (const animation of caret.getAnimations()) animation.currentTime = 0;
    }
    measured.current = { value: input.value, start: at, end: input.selectionEnd, width, top: input.scrollTop, left: input.scrollLeft, reveal, focused };
  }, []);
  const scheduleMeasure = useCallback((reveal = false, refresh = false) => {
    if (!activeRef.current) return;
    if (refresh) metrics.current = null;
    revealPending.current ||= reveal;
    if (measureFrame.current) return;
    measureFrame.current = requestAnimationFrame(() => {
      measureFrame.current = 0;
      const reveal = revealPending.current;
      revealPending.current = false;
      const start = performance.now();
      measure(reveal);
      const end = performance.now();
      performance.measure("gsv.prompt.measure", { start, end });
      performance.clearMeasures("gsv.prompt.measure");
      for (const sample of caretTimings.current.splice(0)) {
        const name = sample.kind === "input" ? "gsv.prompt.input-to-caret" : "gsv.prompt.cursor-to-caret";
        performance.measure(name, { start: sample.start, end });
        performance.clearMeasures(name);
      }
    });
  }, [measure]);
  useLayoutEffect(() => {
    if (!active) {
      cancelAnimationFrame(measureFrame.current);
      measureFrame.current = 0;
      caretTimings.current.length = 0;
      return;
    }
    metrics.current = null;
    measure(true);
  }, [active, measure, disabled, command, place.label, place.online, dir]);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!active || !input) return;
    const selectionChanged = () => scheduleMeasure(true);
    // `select` does not report an ordinary collapsed-caret move in WebKit.
    input.addEventListener("selectionchange", selectionChanged);
    return () => input.removeEventListener("selectionchange", selectionChanged);
  }, [active, scheduleMeasure]);
  useLayoutEffect(() => {
    if (!active || !autoFocus || disabled || autoFocusHandled.current) return;
    autoFocusHandled.current = true;
    if (document.activeElement === document.body || document.activeElement === null) inputRef.current?.focus();
  }, [active, autoFocus, disabled]);
  useEffect(() => {
    const field = fieldRef.current;
    if (!active || !field) return;
    const refresh = () => scheduleMeasure(true, true);
    const observer = new ResizeObserver(refresh);
    observer.observe(field);
    if (chipRef.current) observer.observe(chipRef.current);
    document.fonts.addEventListener("loadingdone", refresh);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", refresh);
      cancelAnimationFrame(measureFrame.current);
    };
  }, [active, scheduleMeasure]);
  const read = (): string => inputRef.current?.value ?? "";
  const changed = (event?: Event): void => {
    if (event) recordCaretInput(event, "input");
    revision.current++;
    const value = read();
    setCommand(value.startsWith("$"));
    onInput?.(value);
    scheduleMeasure(true);
  };
  useImperativeHandle(ref, () => ({
    disabled: Boolean(disabled),
    get chip() { return chipRef.current; },
    selection: () => ({ value: read(), start: inputRef.current?.selectionStart ?? 0, end: inputRef.current?.selectionEnd ?? 0 }),
    setValue(value, caret) {
      if (!inputRef.current) return;
      inputRef.current.value = value;
      if (caret !== undefined) inputRef.current.setSelectionRange(caret, caret);
      changed();
    },
    append(text) {
      const input = inputRef.current;
      if (!input || disabled) return;
      input.focus();
      input.setRangeText(text, input.value.length, input.value.length, "end");
      changed();
    },
    focus: () => inputRef.current?.focus(),
    blur: () => inputRef.current?.blur(),
    submit: () => { void send(); },
  }));
  const send = async () => {
    const input = inputRef.current;
    if (!input || disabled || submitting.current) return;
    if (interceptSubmit?.()) return;
    const text = input.value.trim();
    if ((!text && !allowEmpty) || text === "$") return;
    const sentRevision = revision.current;
    submitting.current = true;
    try {
      const accepted = await onSubmit(text);
      if (accepted !== false && inputRef.current === input && revision.current === sentRevision) {
        input.value = text.startsWith("$") ? "$ " : "";
        input.setSelectionRange(input.value.length, input.value.length);
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
    if (onHistory && (input.value === "" || input.value.trim() === "$") && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      onHistory(event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
      recordCaretInput(event, "cursor");
      // The frame observes the browser's default selection change, including held-key repeats.
      scheduleMeasure(true);
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
          onScroll={() => scheduleMeasure()}
          onInput={changed}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (onFiles && files.length > 0) { event.preventDefault(); onFiles(files); }
          }}
          onFocus={() => {
            scheduleMeasure(true);
            onFocusChange?.(true);
          }}
          onBlur={() => {
            if (caretRef.current) caretRef.current.style.visibility = "hidden";
            measured.current = null;
            onFocusChange?.(false);
          }}
        />
        <span class="mirror" ref={mirrorRef} aria-hidden="true" />
        <span class="block-caret" ref={caretRef} aria-hidden="true" />
      </span>
    </form>
  );
});
