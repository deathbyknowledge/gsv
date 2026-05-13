import { useEffect, useMemo, useState } from "preact/hooks";
import type { GsvBackend } from "../../backend-contract";
import { errorToText } from "../../utils/format";
import type { AddMcpServerArgs, McpServer, McpState, McpTransportType } from "./types";

export type AddMcpForm = {
  name: string;
  url: string;
  transport: McpTransportType;
};

export type McpServersRuntime = {
  state: McpState;
  loading: boolean;
  pendingAction: string | null;
  error: string | null;
  notice: string | null;
  selectedServerId: string | null;
  selectedServer: McpServer | null;
  signInOpenedFor: string | null;
  form: AddMcpForm;
  setForm: (form: AddMcpForm | ((current: AddMcpForm) => AddMcpForm)) => void;
  setSelectedServerId(serverId: string | null): void;
  clearMessages(): void;
  refresh(): Promise<void>;
  addServer(): Promise<void>;
  refreshServer(serverId: string): Promise<void>;
  removeServer(serverId: string): Promise<void>;
  openSignIn(server: McpServer): void;
};

const EMPTY_STATE: McpState = {
  servers: [],
};

export function useMcpServers(backend: GsvBackend): McpServersRuntime {
  const [state, setState] = useState<McpState>(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(readMcpServerFromLocation);
  const [signInOpenedFor, setSignInOpenedFor] = useState<string | null>(null);
  const [form, setForm] = useState<AddMcpForm>({
    name: "",
    url: "",
    transport: "auto",
  });

  const selectedServer = useMemo(
    () => state.servers.find((server) => server.serverId === selectedServerId) ?? state.servers[0] ?? null,
    [selectedServerId, state.servers],
  );

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (state.servers.length === 0) {
      if (selectedServerId !== null) {
        selectServer(null);
      }
      return;
    }
    if (!selectedServerId || !state.servers.some((server) => server.serverId === selectedServerId)) {
      selectServer(state.servers[0].serverId);
    }
  }, [selectedServerId, state.servers]);

  useEffect(() => {
    if (!signInOpenedFor) {
      return;
    }
    const onFocus = () => {
      void refreshServer(signInOpenedFor);
      setSignInOpenedFor(null);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [signInOpenedFor]);

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setState(await backend.loadMcpState());
    } catch (cause) {
      setError(errorToText(cause));
    } finally {
      setLoading(false);
    }
  }

  async function runMutation(action: string, task: () => Promise<void>): Promise<void> {
    setPendingAction(action);
    setError(null);
    setNotice(null);
    try {
      await task();
    } catch (cause) {
      setError(errorToText(cause));
    } finally {
      setPendingAction(null);
    }
  }

  function selectServer(serverId: string | null): void {
    setSelectedServerId(serverId);
    const url = new URL(window.location.href);
    url.searchParams.set("section", "integrations");
    url.searchParams.set("type", "mcp-servers");
    if (serverId) {
      url.searchParams.set("mcpServer", serverId);
    } else {
      url.searchParams.delete("mcpServer");
    }
    window.history.replaceState({}, "", url);
  }

  async function addServer(): Promise<void> {
    const args: AddMcpServerArgs = {
      name: form.name,
      url: form.url,
      transport: form.transport,
      callbackHost: window.location.origin,
    };
    await runMutation("mcp:add", async () => {
      const result = await backend.addMcpServer(args);
      setState(result.state);
      setForm({ name: "", url: "", transport: "auto" });
      setNotice(result.server?.state === "authenticating"
        ? `${result.server.name} needs provider sign-in.`
        : `${result.server?.name ?? args.name} was connected.`);
      selectServer(result.server?.serverId ?? null);
      if (result.server?.state === "authenticating" && result.server.authUrl) {
        openSignIn(result.server);
      }
    });
  }

  async function refreshServer(serverId: string): Promise<void> {
    await runMutation(`mcp:refresh:${serverId}`, async () => {
      const result = await backend.refreshMcpServer({ serverId });
      setState(result.state);
      if (result.server) {
        setNotice(`${result.server.name} was refreshed.`);
        selectServer(result.server.serverId);
      }
    });
  }

  async function removeServer(serverId: string): Promise<void> {
    await runMutation(`mcp:remove:${serverId}`, async () => {
      const result = await backend.removeMcpServer({ serverId });
      setState(result);
      setNotice("MCP server removed.");
      selectServer(null);
    });
  }

  function openSignIn(server: McpServer): void {
    if (!server.authUrl) {
      return;
    }
    window.open(server.authUrl, "_blank", "noopener,noreferrer");
    setSignInOpenedFor(server.serverId);
  }

  function clearMessages(): void {
    setError(null);
    setNotice(null);
  }

  return {
    state,
    loading,
    pendingAction,
    error,
    notice,
    selectedServerId,
    selectedServer,
    signInOpenedFor,
    form,
    setForm,
    setSelectedServerId: selectServer,
    clearMessages,
    refresh,
    addServer,
    refreshServer,
    removeServer,
    openSignIn,
  };
}

function readMcpServerFromLocation(): string | null {
  const value = new URL(window.location.href).searchParams.get("mcpServer");
  return value?.trim() || null;
}
