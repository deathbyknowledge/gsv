import { useEffect, useState } from "preact/hooks";
import { IconButton } from "../../../components/ui/IconButton";
import { Hint } from "../../../components/ui/Tooltip";
import { useT } from "../../../i18n/locale";

export type CodeCopyState = "idle" | "copied" | "failed";

/** How long a copy outcome shows before the control returns to rest. */
const SETTLE_MS = 2000;

/**
 * Copying a code block's text. Each attempt shows its outcome for a moment, a repeated copy starting the moment
 * again; a new `text` returns the control to rest. Copying never executes the code.
 */
export function useCodeCopy(read: () => string, text?: string) {
  const [attempt, setAttempt] = useState<{ state: CodeCopyState; count: number }>({ state: "idle", count: 0 });
  useEffect(() => {
    if (attempt.state === "idle") return undefined;
    const settle = setTimeout(() => setAttempt((current) => ({ ...current, state: "idle" })), SETTLE_MS);
    return () => clearTimeout(settle);
  }, [attempt]);
  useEffect(() => { setAttempt((current) => ({ ...current, state: "idle" })); }, [text]);
  const copy = () => {
    navigator.clipboard.writeText(read()).then(
      () => setAttempt((current) => ({ state: "copied", count: current.count + 1 })),
      () => setAttempt((current) => ({ state: "failed", count: current.count + 1 })),
    );
  };
  return { state: attempt.state, copy };
}

/** The outcome as the short note shown beside or beneath the block. */
export function useCodeCopyOutcome(state: CodeCopyState): string {
  const t = useT();
  return state === "copied" ? t("shell.copied") : state === "failed" ? t("shell.code.copyFailed") : "";
}

/** The copy control; its hint says what a click does now, including copying by hand after a failure. */
export function CodeCopyButton({ state, copy, label }: { state: CodeCopyState; copy: () => void; label?: string }) {
  const t = useT();
  const rest = label ?? t("shell.code.copyTitle");
  const hint = state === "copied" ? t("shell.copied") : state === "failed" ? t("shell.code.copyManually") : rest;
  return <span class="markdown-code-copy">
    <Hint text={hint}>
      <IconButton glyph="copy" size={36} variant="floating" className={state === "idle" ? undefined : `is-${state}`}
        ariaLabel={rest} onClick={copy} />
    </Hint>
  </span>;
}

/** A code block header's actions: the copy outcome, then the copy control. */
export function CodeCopyAction({ read, text, label }: { read: () => string; text?: string; label?: string }) {
  const { state, copy } = useCodeCopy(read, text);
  const outcome = useCodeCopyOutcome(state);
  return <>
    <span class="markdown-code-status" aria-live="polite">{outcome}</span>
    <CodeCopyButton state={state} copy={copy} label={label} />
  </>;
}
