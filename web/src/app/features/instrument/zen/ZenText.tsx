import { useId, useLayoutEffect, useMemo, useRef } from "preact/hooks";
import { memo } from "preact/compat";
import type { JSX } from "preact";
import { renderMarkdownHtml, renderPlainTextHtml } from "../shared/markdown";
import { enhanceCodeBlocks } from "../shared/codeBlocks";
import { createGlyphReveal, type GlyphReveal } from "./glyphReveal";
import { linkPlaceReferences, type Place } from "./zenModel";
import { FOLDED_LINES, lineHeight, useFold } from "./zenFold";

export const ZenText = memo(function ZenText({ text, markdown, places, progress, tick, opened = false, onClick, onFold }: {
  text: string;
  markdown: boolean;
  places?: readonly Place[];
  /** null is settled; negative means the tail of a live reply. */
  progress: number | null;
  tick: number;
  /** Start a long message open: the reader watched it arrive. */
  opened?: boolean;
  onClick?: JSX.MouseEventHandler<HTMLDivElement>;
  /** Called with the element to hold in place just before the message folds or opens. */
  onFold?: (element: HTMLElement) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const reveal = useRef<GlyphReveal | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const streaming = progress !== null && progress < 0;
  const fold = useFold(streaming, opened);
  const folded = fold.state === "folded";
  const html = useMemo(() => markdown ? renderMarkdownHtml(places ? linkPlaceReferences(text, places) : text) : renderPlainTextHtml(text), [markdown, places, text]);
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
    if (markdown) enhanceCodeBlocks(element);
    return () => {
      reveal.current?.dispose();
      reveal.current = null;
    };
  }, [html, markdown, streaming]);
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
  useLayoutEffect(() => {
    const element = ref.current;
    const body = content.current;
    if (!element || !body || streaming) return undefined;
    // The body is never capped, so its height is the whole message even while folded.
    const measure = () => fold.measured(body.offsetHeight / lineHeight(getComputedStyle(element)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [html, streaming, fold.measured]);
  // Opening keeps the text where it is; folding keeps the toggle under the reader.
  const toggle = () => {
    const held = folded ? ref.current : toggleRef.current;
    if (held) onFold?.(held);
    fold.toggle();
  };
  return <>
    <div
      id={id}
      class={`text zen-resolving-text${folded ? " is-folded" : ""}`}
      style={folded ? { maxHeight: `${FOLDED_LINES}lh` } : undefined}
      ref={ref}
      onClick={onClick}
      onFocusIn={(event) => {
        // A link reached by keyboard beneath the fold opens the message rather than hiding focus.
        const element = ref.current;
        if (!folded || !element || !(event.target instanceof Element)) return;
        if (event.target.getBoundingClientRect().bottom <= element.getBoundingClientRect().bottom) return;
        onFold?.(element);
        fold.open();
      }}
    ><div ref={content} /></div>
    {fold.state === "whole" ? null : (
      <button type="button" class="zen-fold-toggle" ref={toggleRef} aria-controls={id} aria-expanded={!folded} onClick={toggle}>
        {folded ? "read more" : "show less"}
      </button>
    )}
  </>;
});
