import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { normalizeProcessAiState, type ProcessAiReasoningLevel } from "../domain/process-ai";
import type { ChatBackend, ProcessAiState, ThreadContext } from "../types";
import { asRecord, formatError, safeText } from "../view-helpers";

type ProcessAiAction =
  | `profile:${string}`
  | `field:${string}`
  | "clear"
  | null;

export function useProcessAiConfig({
  backend,
  active,
}: {
  backend: ChatBackend;
  active: ThreadContext | null;
}) {
  const activePid = active?.pid ?? "";
  const requestIdRef = useRef(0);
  const [state, setState] = useState<ProcessAiState | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<ProcessAiAction>(null);
  const [error, setError] = useState("");

  const reload = useCallback(async (pid = activePid) => {
    if (!pid) {
      setState(null);
      setLoading(false);
      setError("");
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError("");
    try {
      const result = await backend.getProcessAiConfig({ pid });
      if (requestIdRef.current !== requestId) {
        return;
      }
      const record = asRecord(result);
      if (!record?.ok) {
        setState(null);
        setError(safeText(record?.error || "AI config unavailable"));
        return;
      }
      setState(normalizeProcessAiState(result));
    } catch (loadError) {
      if (requestIdRef.current === requestId) {
        setState(null);
        setError(formatError(loadError));
      }
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [activePid, backend]);

  const mutate = useCallback(async (
    action: ProcessAiAction,
    operation: (pid: string) => Promise<unknown>,
  ) => {
    if (!activePid || pendingAction) {
      return;
    }
    setPendingAction(action);
    setError("");
    try {
      const result = await operation(activePid);
      const record = asRecord(result);
      if (!record?.ok) {
        setError(safeText(record?.error || "AI config update failed"));
        return;
      }
      await reload(activePid);
    } catch (updateError) {
      setError(formatError(updateError));
    } finally {
      setPendingAction(null);
    }
  }, [activePid, pendingAction, reload]);

  const applyProfile = useCallback(async (profile: string) => {
    await mutate(`profile:${profile}`, (pid) => backend.setProcessAiProfile({ pid, profile }));
  }, [backend, mutate]);

  const clearOverride = useCallback(async () => {
    await mutate("clear", (pid) => backend.setProcessAiProfile({ pid, profile: "" }));
  }, [backend, mutate]);

  const setReasoning = useCallback(async (reasoning: ProcessAiReasoningLevel) => {
    await mutate(`field:reasoning`, (pid) => backend.setProcessAiField({ pid, field: "reasoning", value: reasoning }));
  }, [backend, mutate]);

  useEffect(() => {
    void reload(activePid);
  }, [activePid, reload]);

  return {
    processAiState: state,
    processAiLoading: loading,
    processAiPendingAction: pendingAction,
    processAiError: error,
    reloadProcessAiConfig: reload,
    applyProcessAiProfile: applyProfile,
    clearProcessAiOverride: clearOverride,
    setProcessAiReasoning: setReasoning,
  };
}
