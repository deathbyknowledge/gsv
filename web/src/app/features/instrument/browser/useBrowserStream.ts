import { useEffect, useState } from "preact/hooks";
import type { GSVClient } from "@humansandmachines/gsv/client";
import type { BrowserViewFrame, BrowserViewState } from "@humansandmachines/gsv/protocol";
import { watchBrowser } from "../../../services/instances/browserControl";

export type BrowserImage = { source: string; data: BrowserViewFrame; presented: () => void };

export function useBrowserStream(client: GSVClient, instanceId: string, tabId: number | undefined, enabled: boolean) {
  const [frame, setFrame] = useState<BrowserImage | null>(null);
  const [state, setState] = useState<BrowserViewState>();
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(document.visibilityState !== "hidden");
  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    if (!enabled || !visible) return;
    let stopped = false, retry = 250;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let connection: AbortController;
    const urls = new Set<string>();
    const paints = new Set<number>();
    const releaseUrls = (keep?: string) => {
      for (const url of urls) if (url !== keep) { URL.revokeObjectURL(url); urls.delete(url); }
    };
    const connect = async () => {
      const active = new AbortController(); connection = active;
      try {
        const stream = await watchBrowser(client, { instanceId, tabId }, active.signal);
        for await (const packet of stream) {
          if (active.signal.aborted) return;
          if (packet.metadata.kind === "state") { setState(packet.metadata); continue; }
          const metadata = packet.metadata;
          const source = URL.createObjectURL(new Blob([new Uint8Array(packet.image)], { type: "image/jpeg" }));
          urls.add(source);
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => finish(new Error("Browser image did not display")), 10000);
            const abort = () => finish(active.signal.reason);
            const finish = (cause?: unknown) => {
              clearTimeout(timeout); active.signal.removeEventListener("abort", abort);
              if (cause) reject(cause); else resolve();
            };
            active.signal.addEventListener("abort", abort, { once: true });
            setFrame({ source, data: metadata, presented: () => {
              if (active.signal.aborted) return;
              releaseUrls(source);
              const paint = requestAnimationFrame(() => { paints.delete(paint); finish(); });
              paints.add(paint);
            } });
          });
          retry = 250; setError("");
        }
        if (!stopped) throw new Error("Browser view stream ended");
      } catch (cause) { if (!stopped) setError(String(cause)); }
      finally {
        active.abort();
        if (!stopped) { timer = setTimeout(() => void connect(), retry); retry = Math.min(2000, retry * 2); }
      }
    };
    void connect();
    return () => {
      stopped = true; connection?.abort(); clearTimeout(timer);
      for (const paint of paints) cancelAnimationFrame(paint);
      releaseUrls();
    };
  }, [client, instanceId, tabId, enabled, visible]);
  return { frame, state, error };
}
