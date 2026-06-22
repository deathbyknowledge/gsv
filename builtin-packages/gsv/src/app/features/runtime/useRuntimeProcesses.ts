import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { GsvBackend } from "../../backend-contract";
import { errorToText } from "../../utils/format";
import type { AgentDetail, AgentModelProfile } from "../agents/types";
import { filterProcesses } from "./runtime-domain";
import type { ProcessEntry, RuntimeState } from "./types";

export function useRuntimeProcesses(backend: GsvBackend) {
  const [state, setState] = useState<RuntimeState | null>(null);
  const [agents, setAgents] = useState<AgentDetail[]>([]);
  const [models, setModels] = useState<AgentModelProfile[]>([]);
  const [systemAiValues, setSystemAiValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState("");
  const [query, setQueryState] = useState(readRuntimeQuery);
  const [selectedPid, setSelectedPid] = useState<string | null>(readRuntimePid);
  const [killingPid, setKillingPid] = useState("");
  const requestIdRef = useRef(0);

  const loadState = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const [nextState, nextAgents] = await Promise.all([
        backend.loadRuntimeState(),
        backend.loadAgentsState(),
      ]);
      if (requestId !== requestIdRef.current) {
        return;
      }
      setState(nextState);
      setAgents(nextAgents.agents);
      setModels(nextAgents.modelProfiles);
      setSystemAiValues(nextAgents.systemAiValues);
      setErrorText(nextState.errorText);
    } catch (error) {
      if (requestId === requestIdRef.current) {
        setErrorText(errorToText(error));
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [backend]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    const onPopState = () => {
      setQueryState(readRuntimeQuery());
      setSelectedPid(readRuntimePid());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const filteredProcesses = useMemo(() => {
    return filterProcesses(state?.processes ?? [], query);
  }, [query, state?.processes]);

  const setQuery = useCallback((nextQuery: string) => {
    setQueryState(nextQuery);
    writeRuntimeRoute({ q: nextQuery, pid: null });
  }, []);

  const selectProcess = useCallback((process: ProcessEntry) => {
    setSelectedPid(process.pid);
    writeRuntimeRoute({ pid: process.pid });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedPid(null);
    writeRuntimeRoute({ pid: null });
  }, []);

  const killProcess = useCallback(async (pid: string) => {
    const normalizedPid = pid.trim();
    if (!normalizedPid || killingPid) {
      return;
    }
    setKillingPid(normalizedPid);
    try {
      const result = await backend.killRuntimeProcess({ pid: normalizedPid });
      if (!result.ok) {
        setErrorText(result.errorText);
        return;
      }
      setErrorText("");
      await loadState();
    } catch (error) {
      setErrorText(errorToText(error));
    } finally {
      setKillingPid("");
    }
  }, [backend, killingPid, loadState]);

  return {
    state,
    loading,
    errorText,
    query,
    agents,
    models,
    systemAiValues,
    selectedPid,
    filteredProcesses,
    killingPid,
    totalCount: state?.processes.length ?? 0,
    setQuery,
    selectProcess,
    clearSelection,
    loadState,
    killProcess,
  };
}

function readRuntimeQuery(): string {
  return new URL(window.location.href).searchParams.get("q")?.trim() ?? "";
}

function readRuntimePid(): string | null {
  const value = new URL(window.location.href).searchParams.get("pid")?.trim() ?? "";
  return value || null;
}

function writeRuntimeRoute(next: { q?: string; pid?: string | null }, replace = false): void {
  const url = new URL(window.location.href);
  url.searchParams.set("section", "runtime");

  if (next.q !== undefined) {
    const q = next.q.trim();
    if (q) {
      url.searchParams.set("q", q);
    } else {
      url.searchParams.delete("q");
    }
  }

  if (next.pid !== undefined) {
    const pid = next.pid?.trim() ?? "";
    if (pid) {
      url.searchParams.set("pid", pid);
    } else {
      url.searchParams.delete("pid");
    }
  }

  window.history[replace ? "replaceState" : "pushState"]({}, "", url);
}
