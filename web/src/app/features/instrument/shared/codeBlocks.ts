import { h, render } from "preact";
import { t } from "../../../i18n/locale";
import { CodeCopyAction } from "./codeCopy";
import "./codeBlocks.css";

/** Add local controls after Markdown has been sanitized; copying never executes the code. */
export function enhanceCodeBlocks(container: HTMLElement): void {
  for (const code of container.querySelectorAll<HTMLElement>("pre > code")) {
    const pre = code.parentElement!;
    if (pre.parentElement?.classList.contains("markdown-code-block")) continue;
    const block = document.createElement("div");
    block.className = "markdown-code-block";
    const header = document.createElement("div");
    header.className = "markdown-code-header";
    const language = document.createElement("span");
    language.textContent = [...code.classList].find((name) => name.startsWith("language-"))?.slice(9) ?? "";
    // Untagged fences carry prose more often than code; let them wrap at every width.
    if (language.textContent === "" || language.textContent === "text") block.classList.add("is-plain-text");
    const actions = document.createElement("span");
    actions.className = "markdown-code-actions";
    // Omit Marked's added final newline while preserving the code's internal whitespace.
    render(h(CodeCopyAction, { read: () => (code.textContent ?? "").replace(/\n$/, "") }), actions);
    header.append(language, actions);
    pre.before(block);
    pre.tabIndex = 0;
    pre.setAttribute("aria-label", t("shell.code.label"));
    block.append(header, pre);
  }
}
