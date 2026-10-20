import { t } from "../../../i18n/locale";
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
    if (language.textContent === "text") block.classList.add("is-plain-text");
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = t("shell.code.copy");
    copy.title = t("shell.code.copyTitle");
    copy.setAttribute("aria-live", "polite");
    copy.addEventListener("click", async () => {
      try {
        // Omit Marked's added final newline while preserving the code's internal whitespace.
        await navigator.clipboard.writeText((code.textContent ?? "").replace(/\n$/, ""));
        copy.textContent = t("shell.copied");
        copy.title = t("shell.code.copyTitle");
      } catch {
        copy.textContent = t("shell.code.copyFailed");
        copy.title = t("shell.code.copyManually");
      }
    });
    header.append(language, copy);
    pre.before(block);
    pre.tabIndex = 0;
    pre.setAttribute("aria-label", t("shell.code.label"));
    block.append(header, pre);
  }
}
