import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { computeUserBubbleWidth } from "../domain/pretext-layout";

export function usePretextBubbleWidth(text: string, enabled: boolean, headerParts: string[]) {
  const bubbleRef = useRef<HTMLElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const headerKey = headerParts.join("\0");
  const [fontsReady, setFontsReady] = useState(() => (
    typeof document === "undefined" || !document.fonts ? true : document.fonts.status === "loaded"
  ));

  useEffect(() => {
    if (!enabled || fontsReady || typeof document === "undefined" || !document.fonts) {
      return undefined;
    }
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) {
        setFontsReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, fontsReady]);

  useEffect(() => {
    if (!enabled) {
      setContainerWidth(0);
      return undefined;
    }
    const node = bubbleRef.current;
    const container = node?.parentElement;
    if (!container) {
      return undefined;
    }

    const updateWidth = () => setContainerWidth(container.clientWidth);
    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }

    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, [enabled]);

  const width = useMemo(() => (
    enabled && fontsReady ? computeUserBubbleWidth(text, containerWidth, headerParts) : null
  ), [containerWidth, enabled, fontsReady, headerKey, text]);

  return {
    bubbleRef,
    bubbleStyle: width === null ? undefined : { width: `${width}px` },
  };
}
