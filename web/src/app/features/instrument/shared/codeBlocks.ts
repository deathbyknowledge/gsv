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
    copy.textContent = "copy";
    copy.title = "Copy code";
    copy.setAttribute("aria-live", "polite");
    copy.addEventListener("click", async () => {
      try {
        // Omit Marked's added final newline while preserving the code's internal whitespace.
        await navigator.clipboard.writeText((code.textContent ?? "").replace(/\n$/, ""));
        copy.textContent = "copied";
        copy.title = "Copy code";
      } catch {
        copy.textContent = "couldn't copy";
        copy.title = "Select the code and copy it manually";
      }
    });
    header.append(language, copy);
    pre.before(block);
    pre.tabIndex = 0;
    pre.setAttribute("aria-label", "Code block");
    block.append(header, pre);
  }
}
