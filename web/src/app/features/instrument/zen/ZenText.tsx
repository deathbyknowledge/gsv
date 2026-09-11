import { useLayoutEffect, useMemo, useRef } from "preact/hooks";
import type { JSX } from "preact";
import { escapeHtml, renderMarkdownHtml } from "../shared/markdown";
import { createGlyphReveal, type GlyphReveal } from "./glyphReveal";

export function ZenText({ text, markdown, progress, tick, onClick }: {
  text: string;
  markdown: boolean;
  /** null is settled; negative means the tail of a live reply. */
  progress: number | null;
  tick: number;
  onClick?: JSX.MouseEventHandler<HTMLDivElement>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const reveal = useRef<GlyphReveal | null>(null);
  const streaming = progress !== null && progress < 0;
  const html = useMemo(() => markdown ? renderMarkdownHtml(text) : escapeHtml(text), [markdown, text]);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    element.innerHTML = html;
    if (streaming) {
      const caret = document.createElement("span");
      caret.className = "zen-caret blink";
      caret.setAttribute("aria-hidden", "true");
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let last: Text | undefined;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.trim()) {
          // SAFETY: This walker only returns Text nodes because it uses SHOW_TEXT.
          last = node as Text;
        }
      }
      if (last) last.after(caret);
      else element.append(caret);
    }
    return () => {
      reveal.current?.dispose();
      reveal.current = null;
    };
  }, [html, streaming]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !content.current) return;
    if (progress === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      reveal.current?.dispose();
      reveal.current = null;
      return;
    }
    reveal.current ??= createGlyphReveal(element, content.current);
    reveal.current?.paint(progress);
  }, [html, progress, tick]);
  return <div class="text zen-resolving-text" ref={ref} onClick={onClick}><div ref={content} /></div>;
}
