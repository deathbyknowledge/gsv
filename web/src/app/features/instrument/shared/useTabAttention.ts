import { useEffect, useRef } from "preact/hooks";
import { z } from "zod";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { badgeIcon, createTabAttention, type TabAttention } from "./tabAttention";

/* the part of a committed message the tab signal reads: who wrote it, and which message it is */
const committedMessageSchema = z.object({
  message: z.object({ id: z.string(), author: z.object({ kind: z.string() }) }),
});

/**
 * Shows Ship messages that land while the person is looking elsewhere in the browser
 * tab: "(N) GSV" in the title and a dot on the favicon until the tab is viewed again.
 * Live `message.committed` signals are the only source, so history loaded on first
 * paint or after a reconnect never counts, and the person's own messages are skipped.
 */
export function useTabAttention(): void {
  const { client, connected } = useGateway();
  const attention = useRef<TabAttention | null>(null);

  useEffect(() => {
    const current = createTabAttention({
      document,
      icons: [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')],
      badge: badgeIcon,
    });
    attention.current = current;
    const viewed = () => current.viewed();
    document.addEventListener("visibilitychange", viewed);
    window.addEventListener("focus", viewed);
    return () => {
      document.removeEventListener("visibilitychange", viewed);
      window.removeEventListener("focus", viewed);
      current.dispose();
      attention.current = null;
    };
  }, []);

  useEffect(() => {
    if (!connected) return;
    return client.onSignal((signal, payload) => {
      if (signal !== "message.committed") return;
      const committed = committedMessageSchema.safeParse(payload);
      if (!committed.success || committed.data.message.author.kind !== "process") return;
      attention.current?.arrived(committed.data.message.id);
    });
  }, [client, connected]);
}
