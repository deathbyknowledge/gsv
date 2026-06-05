import { onAppEvent } from "@gsv/package/browser";
import { useEffect } from "preact/hooks";
import type { ChatBackend } from "../types";
import { formatError } from "../view-helpers";

const CATALOG_SIGNALS = new Set([
  "proc.changed",
  "proc.run.started",
  "proc.run.finished",
  "proc.run.hil.requested",
  "process.exit",
]);

export function useProcessCatalogSignals({
  backend,
  applySignal,
  loadThreads,
  onError,
}: {
  backend: ChatBackend;
  applySignal(signal: string, payload: unknown): boolean;
  loadThreads(): Promise<void>;
  onError(message: string): void;
}) {
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const refreshSoon = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        if (!disposed) {
          void loadThreads();
        }
      }, 150);
    };

    const unsubscribe = onAppEvent((signal, payload) => {
      if (CATALOG_SIGNALS.has(signal) && !applySignal(signal, payload)) {
        refreshSoon();
      }
    });

    void backend.watchProcessSignals({ scope: "owner" }).catch((error) => {
      if (!disposed) {
        onError(formatError(error));
      }
    });

    return () => {
      disposed = true;
      unsubscribe();
      if (timer) {
        clearTimeout(timer);
      }
      void backend.unwatchProcessSignals({ scope: "owner" }).catch(() => {});
    };
  }, [applySignal, backend, loadThreads, onError]);
}
