import { h, render } from "preact";
import { IconButton } from "../../../components/ui/IconButton";
import { t } from "../../../i18n/locale";
import "./codeBlocks.css";

type CopyState = "idle" | "copied" | "failed";

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
    const status = document.createElement("span");
    status.className = "markdown-code-status";
    status.setAttribute("aria-live", "polite");
    const mount = document.createElement("span");
    mount.className = "markdown-code-copy";
    let state: CopyState = "idle";
    let settle: ReturnType<typeof setTimeout> | undefined;
    const paint = () => {
      render(h(IconButton, {
        glyph: "copy",
        size: 36,
        variant: "floating",
        className: state === "idle" ? undefined : `is-${state}`,
        title: state === "copied" ? t("shell.copied") : state === "failed" ? t("shell.code.copyManually") : t("shell.code.copyTitle"),
        onClick: () => void copyCode(),
      }), mount);
    };
    const copyCode = async () => {
      try {
        // Omit Marked's added final newline while preserving the code's internal whitespace.
        await navigator.clipboard.writeText((code.textContent ?? "").replace(/\n$/, ""));
        state = "copied";
        status.textContent = t("shell.copied");
      } catch {
        state = "failed";
        status.textContent = t("shell.code.copyFailed");
      }
      paint();
      clearTimeout(settle);
      settle = setTimeout(() => { state = "idle"; status.textContent = ""; paint(); }, 2000);
    };
    paint();
    actions.append(status, mount);
    header.append(language, actions);
    pre.before(block);
    pre.tabIndex = 0;
    pre.setAttribute("aria-label", t("shell.code.label"));
    block.append(header, pre);
  }
}
