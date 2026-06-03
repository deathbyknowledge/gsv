import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { GsvBackend } from "../../backend-contract";
import { errorToText } from "../../utils/format";
import type {
  AgentContextFile,
  AgentDetail,
  AgentsState,
  CreateAgentArgs,
  CreateHumanArgs,
  SetAgentBehaviorArgs,
} from "./types";

export function useAgents(backend: GsvBackend) {
  const [state, setState] = useState<AgentsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState("");
  const [selectedUsername, setSelectedUsername] = useState<string | null>(null);
  const [context, setContext] = useState<AgentContextFile[]>([]);
  const [contextLoading, setContextLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const requestIdRef = useRef(0);
  const contextRequestIdRef = useRef(0);
  const selectedUsernameRef = useRef<string | null>(null);

  const loadState = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const next = await backend.loadAgentsState();
      if (requestId !== requestIdRef.current) return;
      setState(next);
      setErrorText(next.errorText);
    } catch (error) {
      if (requestId === requestIdRef.current) setErrorText(errorToText(error));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [backend]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const selectedAgent = useMemo<AgentDetail | null>(() => {
    if (!selectedUsername) return null;
    return state?.agents.find((agent) => agent.username === selectedUsername) ?? null;
  }, [selectedUsername, state?.agents]);

  const loadContext = useCallback(async (username: string) => {
    const requestId = ++contextRequestIdRef.current;
    setContextLoading(true);
    try {
      const result = await backend.loadAgentContext({ username });
      if (requestId !== contextRequestIdRef.current || selectedUsernameRef.current !== username) {
        return false;
      }
      setContext(result.files);
      if (result.errorText) setErrorText(result.errorText);
      return true;
    } catch (error) {
      if (requestId === contextRequestIdRef.current && selectedUsernameRef.current === username) {
        setErrorText(errorToText(error));
      }
      return false;
    } finally {
      if (requestId === contextRequestIdRef.current && selectedUsernameRef.current === username) {
        setContextLoading(false);
      }
    }
  }, [backend]);

  const selectAgent = useCallback((agent: AgentDetail) => {
    selectedUsernameRef.current = agent.username;
    setSelectedUsername(agent.username);
    setContext([]);
    void loadContext(agent.username);
  }, [loadContext]);

  const clearSelection = useCallback(() => {
    selectedUsernameRef.current = null;
    contextRequestIdRef.current += 1;
    setSelectedUsername(null);
    setContext([]);
    setContextLoading(false);
  }, []);

  const saveContext = useCallback(async (username: string, name: string, text: string) => {
    setBusy(true);
    try {
      const result = await backend.saveAgentContext({ username, name, text });
      if (!result.ok) {
        setErrorText(result.errorText);
        return false;
      }
      setErrorText("");
      await loadContext(username);
      return true;
    } catch (error) {
      setErrorText(errorToText(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, [backend, loadContext]);

  const setBehavior = useCallback(async (args: SetAgentBehaviorArgs) => {
    setBusy(true);
    try {
      const result = await backend.setAgentBehavior(args);
      if (!result.ok) {
        setErrorText(result.errorText);
        return false;
      }
      setErrorText("");
      await loadState();
      return true;
    } catch (error) {
      setErrorText(errorToText(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, [backend, loadState]);

  const createAgent = useCallback(async (args: CreateAgentArgs) => {
    setBusy(true);
    try {
      const result = await backend.createAgent(args);
      if (!result.ok) {
        setErrorText(result.errorText);
        return false;
      }
      setErrorText("");
      await loadState();
      return true;
    } catch (error) {
      setErrorText(errorToText(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, [backend, loadState]);

  const createHuman = useCallback(async (args: CreateHumanArgs) => {
    setBusy(true);
    try {
      const result = await backend.createHuman(args);
      if (!result.ok) {
        setErrorText(result.errorText);
        return false;
      }
      setErrorText("");
      await loadState();
      return true;
    } catch (error) {
      setErrorText(errorToText(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, [backend, loadState]);

  return {
    state,
    loading,
    errorText,
    busy,
    selectedAgent,
    context,
    contextLoading,
    loadState,
    selectAgent,
    clearSelection,
    saveContext,
    setBehavior,
    createAgent,
    createHuman,
  };
}
