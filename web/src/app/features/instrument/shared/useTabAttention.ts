import { useEffect, useRef } from "preact/hooks";
import { useQuery } from "@tanstack/preact-query";
import { z } from "zod";
import { findConsolePersonalProcess } from "../../../domain/system/consoleProcesses";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleProcesses } from "../../../services/system/consoleService";
import { INSTRUMENT_PROCESSES_KEY } from "../wire/queryKeys";
import { badgeIcon, createTabAttention, type TabAttention } from "./tabAttention";

/* the part of a committed message the tab signal reads: which message it is, and which process wrote it */
const committedMessageSchema = z.object({
  message: z.object({ id: z.string(), author: z.union([
    z.object({ kind: z.literal("process"), pid: z.string() }),
    z.object({ kind: z.literal("contact") }),
  ]) }),
  attention: z.enum(["notify", "digest", "quiet"]).optional(),
});

/**
 * Shows Ship messages that land while the person is looking elsewhere in the browser
 * tab: "(N) GSV" in the title and a dot on the favicon until the tab is viewed again.
 * Live `message.committed` signals are the only source, so history loaded on first
 * paint or after a reconnect never counts. Only the personal process commits into the
 * Ship conversation, so a message counts when that process wrote it; the person's own
 * messages and helpers' work conversations are skipped.
 */
export function useTabAttention(): void {
  const { client, connected } = useGateway();
  const attention = useRef<TabAttention | null>(null);
  /* the process list Zen follows Ship through; WireSync patches it when Ship's pid is replaced */
  const processes = useQuery({
    queryKey: INSTRUMENT_PROCESSES_KEY,
    queryFn: () => loadConsoleProcesses(client),
    enabled: connected,
  });
  const shipPid = findConsolePersonalProcess(processes.data ?? [])?.pid ?? null;

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
      if (!committed.success) return;
      const author = committed.data.message.author;
      // People messages additionally use the Kernel's private attention policy.
      if (author.kind === "contact" ? committed.data.attention !== "notify" : author.pid !== shipPid) return;
      attention.current?.arrived(committed.data.message.id);
    });
  }, [client, connected, shipPid]);
}
