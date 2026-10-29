import { useEffect, useState } from "preact/hooks";
import { FieldStatus } from "../../../components/ui/FieldStatus";
import { IconButton } from "../../../components/ui/IconButton";
import { Hint } from "../../../components/ui/Tooltip";
import { useT } from "../../../i18n/locale";
import "./codeBlocks.css";

type CopyState = "idle" | "copied" | "failed";

/** CodeBlock — the chat's fenced-code presentation as a component: a header
 *  with the language and a copy action, then the text. `enhanceCodeBlocks`
 *  builds the same markup around Markdown output; use this where the text is
 *  already in hand (setup commands, invitations). `wrap` lets long one-line
 *  tokens such as pairing codes wrap instead of scrolling; `line` shows a
 *  single command as a field: one elided line with the copy action at the end
 *  and the copy outcome in the field's status note. */
export function CodeBlock({ text, language = "", label, wrap = false, line = false }: { text: string; language?: string; label?: string; wrap?: boolean; line?: boolean }) {
  const t = useT();
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state === "idle") return;
    const settle = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(settle);
  }, [state]);
  useEffect(() => { setState("idle"); }, [text]);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => setState("copied"), () => setState("failed"));
  };
  const outcome = state === "copied" ? t("shell.copied") : state === "failed" ? t("shell.code.copyFailed") : "";
  const action = <span class="markdown-code-copy">
    <Hint text={label ?? t("shell.code.copyTitle")}>
      <IconButton glyph="copy" size={36} variant="floating" className={state === "idle" ? undefined : `is-${state}`}
        ariaLabel={label ?? t("shell.code.copyTitle")} onClick={copy} />
    </Hint>
  </span>;
  if (line) return <div class="markdown-code-field">
    <div class="markdown-code-block is-line">
      <Hint text={text} position="bottom" openOnTap><code tabIndex={0} aria-label={t("shell.code.label")}>{text}</code></Hint>
      {action}
    </div>
    <FieldStatus status={state === "copied" ? "success" : state === "failed" ? "error" : "none"} message={outcome} />
  </div>;
  const plain = wrap || language === "" || language === "text";
  return <div class={`markdown-code-block${plain ? " is-plain-text" : ""}`}>
    <div class="markdown-code-header">
      <span>{language}</span>
      <span class="markdown-code-actions">
        <span class="markdown-code-status" aria-live="polite">{outcome}</span>
        {action}
      </span>
    </div>
    <pre tabIndex={0} aria-label={t("shell.code.label")}><code>{text}</code></pre>
  </div>;
}
