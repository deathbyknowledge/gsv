import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";

export function useConversationReadPosition(conversationId: string, container: RefObject<HTMLElement>, latestRendered: number, enabled: boolean): void {
  const { client, connected } = useGateway();
  const acknowledged = useRef(0);
  useEffect(() => {
    const element = container.current;
    if (!element || !connected || !enabled) return;
    let disposed = false;
    let sending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const markVisible = async () => {
      if (disposed || sending || document.visibilityState !== "visible" || !document.hasFocus()) return;
      const viewport = element.getBoundingClientRect();
      if (!viewport.height || !viewport.width) return;
      let seen = acknowledged.current;
      for (const message of element.querySelectorAll<HTMLElement>("[data-message-sequence]")) {
        const bounds = message.getBoundingClientRect();
        if (bounds.bottom > viewport.top && bounds.top < viewport.bottom) seen = Math.max(seen, Number(message.dataset.messageSequence));
      }
      if (seen <= acknowledged.current) return;
      sending = true;
      try {
        const result = await client.conversation.view.update({ conversationId, readThroughSequence: seen });
        if (!disposed) acknowledged.current = result.entry.view.readThroughSequence;
      } catch {
        // A reconnect or the next visible scroll retries private read state.
      } finally { sending = false; }
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void markVisible(), 180); };
    element.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", schedule);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(element);
    schedule();
    return () => {
      disposed = true; clearTimeout(timer); resize?.disconnect();
      element.removeEventListener("scroll", schedule);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [client, connected, conversationId, container, latestRendered, enabled]);
}
