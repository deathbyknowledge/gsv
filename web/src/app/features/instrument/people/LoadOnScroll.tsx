import { useEffect, useRef } from "preact/hooks";
import { useT } from "../../../i18n/locale";

/**
 * Sits after a paged list and loads the next page as it scrolls into view. It observes again
 * after every page, so a page too short to fill the list keeps loading until one does.
 */
export function LoadOnScroll({ pages, loading, onLoad }: { pages: number; loading: boolean; onLoad: () => void }) {
  const t = useT();
  const sentinel = useRef<HTMLDivElement>(null);
  const load = useRef(onLoad);
  load.current = onLoad;
  useEffect(() => {
    const element = sentinel.current;
    if (!element || loading) return;
    const root = element.closest("[data-scroll-edge]");
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) load.current(); }, { root, rootMargin: "0px 0px 240px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [pages, loading]);
  return <div ref={sentinel} class="people-load-on-scroll" role="status">{loading ? t("people.loadingMore") : null}</div>;
}
