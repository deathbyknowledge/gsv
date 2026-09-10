import { useCallback, useLayoutEffect, useRef, useState } from "preact/hooks";

type Moment = { id: string };
type Anchor = { id: string; offset: number };
const key = (id: string) => id.replace(/^conversation-draft:/, "conversation:");
const atBottom = (element: HTMLElement) => element.scrollHeight - element.clientHeight - element.scrollTop < 24;

/** Follow the bottom until the reader moves away; retain a message and its offset through layout changes. */
export function useZenScroll({ moments, ready, promptFocused, hasOlder, loadingOlder, loadOlder }: {
  moments: readonly Moment[];
  ready: boolean;
  promptFocused: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder(): Promise<void>;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const anchors = useRef<Anchor[]>([]);
  const writtenTop = useRef<number | null>(null);
  const loading = useRef(false);
  const [selected, setSelected] = useState<string | null>(null);
  const current = useRef({ moments, ready, promptFocused, hasOlder, loadingOlder, loadOlder });
  current.current = { moments, ready, promptFocused, hasOlder, loadingOlder, loadOlder };
  const nodes = useCallback(() => Array.from(content.current?.querySelectorAll<HTMLElement>("[data-moment-id]") ?? []), []);
  const inset = useCallback(() => viewport.current ? parseFloat(getComputedStyle(viewport.current).scrollPaddingTop) || 0 : 0, []);
  const capture = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const all = nodes();
    const first = all.findIndex((node) => node.offsetTop + node.offsetHeight > element.scrollTop + inset());
    anchors.current = all.slice(Math.max(0, first), Math.max(0, first) + 3).map((node) => ({
      id: key(node.dataset.momentId!), offset: node.offsetTop - element.scrollTop,
    }));
  }, [inset, nodes]);
  const write = useCallback((top: number) => {
    const element = viewport.current;
    if (!element) return;
    element.scrollTop = top;
    writtenTop.current = element.scrollTop;
  }, []);
  const sync = useCallback(() => {
    const element = viewport.current;
    if (!element || !current.current.ready) return;
    if (following.current) write(element.scrollHeight);
    else {
      const all = nodes();
      for (const anchor of anchors.current) {
        const node = all.find((entry) => key(entry.dataset.momentId!) === anchor.id);
        if (!node) continue;
        write(node.offsetTop - anchor.offset);
        break;
      }
    }
    capture();
  }, [capture, nodes, write]);
  const stopFollowing = useCallback(() => {
    following.current = false;
    capture();
  }, [capture]);
  const follow = useCallback(() => {
    following.current = true;
    setSelected(null);
    sync();
  }, [sync]);
  const readOlder = useCallback(() => {
    const state = current.current;
    if (loading.current || state.loadingOlder || !state.hasOlder || !state.ready) return;
    loading.current = true;
    void state.loadOlder().finally(() => { loading.current = false; });
  }, []);
  const scrolled = useCallback(() => {
    const element = viewport.current;
    if (!element || !current.current.ready) return;
    if (writtenTop.current !== null && Math.abs(element.scrollTop - writtenTop.current) < 1) {
      writtenTop.current = null;
      return;
    }
    writtenTop.current = null;
    following.current = atBottom(element);
    capture();
    setSelected(following.current ? null : anchors.current[0]?.id ?? null);
    if (!following.current && element.scrollTop < 80) readOlder();
  }, [capture, readOlder]);
  const select = useCallback((index: number) => {
    const moment = current.current.moments[index];
    const element = viewport.current;
    const focused = moment && nodes().find((node) => key(node.dataset.momentId!) === key(moment.id));
    if (!element || !focused) return;
    setSelected(key(moment.id));
    // keep the focused moment inside the reading area with a margin, scrolling the container itself
    const margin = 24;
    const top = focused.offsetTop;
    const bottom = top + focused.offsetHeight;
    const available = element.clientHeight - inset() - margin;
    if (focused.offsetHeight > available || top < element.scrollTop + inset()) write(top - inset());
    else if (bottom > element.scrollTop + element.clientHeight - margin) write(bottom + margin - element.clientHeight);
    following.current = atBottom(element);
    capture();
    if (index === 0) readOlder();
  }, [capture, inset, nodes, readOlder, write]);
  const page = useCallback((direction: "up" | "down" | "start" | "end") => {
    const element = viewport.current;
    if (!element) return;
    const distance = Math.max(1, (element.clientHeight - inset() - 24) / 2);
    write(direction === "start" ? 0 : direction === "end" ? element.scrollHeight : element.scrollTop + (direction === "up" ? -distance : distance));
    following.current = atBottom(element);
    capture();
    setSelected(following.current ? null : anchors.current[0]?.id ?? null);
    if (element.scrollTop < 80) readOlder();
  }, [capture, inset, readOlder, write]);

  useLayoutEffect(sync);
  useLayoutEffect(() => {
    const element = viewport.current;
    const body = content.current;
    if (!element || !body) return;
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    observer.observe(body);
    const wheel = (event: WheelEvent) => { if (event.deltaY < 0) stopFollowing(); };
    element.addEventListener("scroll", scrolled, { passive: true });
    element.addEventListener("wheel", wheel, { passive: true });
    element.addEventListener("touchmove", stopFollowing, { passive: true });
    element.addEventListener("pointerdown", stopFollowing, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", scrolled);
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("touchmove", stopFollowing);
      element.removeEventListener("pointerdown", stopFollowing);
    };
  }, [ready, moments.length === 0, scrolled, stopFollowing, sync]);

  const selectedIndex = selected === null ? -1 : moments.findIndex((moment) => key(moment.id) === selected);
  const browse = promptFocused || moments.length === 0 ? null : selectedIndex < 0 ? moments.length - 1 : selectedIndex;
  return { viewport, content, browse, select, page, follow, stopFollowing, readOlder };
}
