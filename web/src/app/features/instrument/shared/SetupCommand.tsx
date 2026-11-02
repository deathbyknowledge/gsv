import { FieldStatus } from "../../../components/ui/FieldStatus";
import { Hint } from "../../../components/ui/Tooltip";
import { useT } from "../../../i18n/locale";
import { CodeCopyButton, useCodeCopy, useCodeCopyOutcome } from "./codeCopy";
import "./codeBlocks.css";

/**
 * A command or code the person copies into a terminal, as a one-line code block: the text elided to the width
 * with the whole of it in the hint, the chat's copy action at the end, and the copy outcome in the status note.
 */
export function SetupCommand({ text, label }: { text: string; label: string }) {
  const t = useT();
  const { state, copy } = useCodeCopy(() => text, text);
  const outcome = useCodeCopyOutcome(state);
  return <div class="markdown-code-field">
    <div class="markdown-code-block is-line">
      <Hint text={text} position="bottom" openOnTap><code tabIndex={0} aria-label={t("shell.code.label")}>{text}</code></Hint>
      <CodeCopyButton state={state} copy={copy} label={label} />
    </div>
    <FieldStatus status={state === "copied" ? "success" : state === "failed" ? "error" : "none"} message={outcome} live />
  </div>;
}
