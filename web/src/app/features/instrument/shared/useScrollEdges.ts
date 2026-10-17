import { useLayoutEffect, useRef } from "preact/hooks";

/** Test text fragments, not row boxes: padding and the gaps between lines stay unmarked. */
function clipsTextAtEdge(pane: HTMLElement, edge: "top" | "bottom"): boolean {
  if (pane.clientHeight === 0) return false;
  if (edge === "top" ? pane.scrollTop <= 0 : pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 1) return false;
  const style = getComputedStyle(pane);
  const overflow = style.overflowY;
  if (overflow !== "auto" && overflow !== "scroll") return false;
  const bounds = pane.getBoundingClientRect();
  const scale = bounds.height / pane.offsetHeight;
  // clientTop/clientHeight round fractional borders at text zoom, which can put
  // the hit test in the adjacent toolbar instead of just inside the scroll pane.
  const border = parseFloat(edge === "top" ? style.borderTopWidth : style.borderBottomWidth) * scale;
  const boundary = edge === "top" ? bounds.top + border : bounds.bottom - border;
  const left = bounds.left + pane.clientLeft * scale;
  const right = left + pane.clientWidth * scale;
  const range = document.createRange();
  const walker = document.createTreeWalker(pane, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      // SAFETY: The walker visits only elements and text, and text returned above.
      const element = node as Element;
      if (element.matches("textarea, input, select, script, style, [aria-hidden='true']")) return NodeFilter.FILTER_REJECT;
      const rect = element.getBoundingClientRect();
      // Prune whole messages, sections and table rows before inspecting their text.
      if (rect.width && (rect.top > boundary || rect.bottom <= boundary || rect.left >= right || rect.right <= left)) return NodeFilter.FILTER_REJECT;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0" || style.position === "fixed") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_SKIP;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      const start = Math.max(left, rect.left);
      const end = Math.min(right, rect.right);
      if (rect.top >= boundary || rect.bottom <= boundary || end <= start) continue;
      // A sticky toolbar can cover text that geometrically crosses the pane's edge.
      const inside = edge === "top" ? Math.min(0.5, (rect.bottom - boundary) / 2) : -Math.min(0.5, (boundary - rect.top) / 2);
      const hit = document.elementFromPoint((start + end) / 2, boundary + inside);
      if (hit && (node.parentElement?.contains(hit) || hit.contains(node))) return true;
    }
  }
  return false;
}

/** The shell owns clipping feedback; each surface keeps its own scrolling and selection. */
export function useScrollEdges(view: string) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current?.querySelector<HTMLElement>(":scope > .instrument-view:not([hidden])");
    if (!root) return;
    let frame = 0;
    let panes: HTMLElement[] = [];
    const observed = new Set<Element>();
    const schedule = () => {
      if (!frame && !document.hidden) frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    const measure = () => {
      frame = 0;
      panes = Array.from(root.querySelectorAll<HTMLElement>("[data-scroll-edge]"));
      const next = new Set<Element>([root]);
      for (const pane of panes) {
        if (pane.clientHeight === 0) continue;
        next.add(pane);
        for (const child of pane.children) next.add(child);
      }
      for (const element of observed) {
        if (!next.has(element)) { resize.unobserve(element); observed.delete(element); }
      }
      for (const element of next) {
        if (!observed.has(element)) { resize.observe(element); observed.add(element); }
      }
      // Finish geometry reads before changing paint, without re-rendering the view.
      const clipped = panes.map((pane) => ({
        top: clipsTextAtEdge(pane, "top"),
        bottom: pane.hasAttribute("data-scroll-edge-bottom") && clipsTextAtEdge(pane, "bottom"),
      }));
      panes.forEach((pane, index) => {
        pane.toggleAttribute("data-scroll-clipped", clipped[index].top);
        pane.toggleAttribute("data-scroll-bottom-clipped", clipped[index].bottom);
      });
    };
    const mutations = new MutationObserver(schedule);
    mutations.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ["class", "style", "hidden", "open"] });
    root.addEventListener("scroll", schedule, { capture: true, passive: true });
    root.addEventListener("load", schedule, true);
    document.fonts.addEventListener("loadingdone", schedule);
    document.addEventListener("visibilitychange", schedule);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      root.removeEventListener("scroll", schedule, true);
      root.removeEventListener("load", schedule, true);
      document.fonts.removeEventListener("loadingdone", schedule);
      document.removeEventListener("visibilitychange", schedule);
      for (const pane of panes) {
        pane.removeAttribute("data-scroll-clipped");
        pane.removeAttribute("data-scroll-bottom-clipped");
      }
    };
  }, [view]);
  return ref;
}
