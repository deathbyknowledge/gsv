import { Telegram } from "./Telegram";
import { LoadingState } from "../../../components/ui/Spinner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { addConsoleMcpServer, loadConsoleMcpServers, refreshConsoleMcpServer, removeConsoleMcpServer } from "../../gsv-console/backend/consoleService";
import type { ConsoleMcpTransport } from "../../gsv-console/domain/consoleModels";
import { canConfigure, SETTINGS_MCP_KEY, signInUrl } from "./settingsModel";
import { SettingsError, useSettingsDirty, type SettingsSectionProps } from "./settingsShared";

export function Integrations({ account, active, onDirty }: SettingsSectionProps) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState<ConsoleMcpTransport>("auto");
  const [removeId, setRemoveId] = useState<string | null>(null);
  const canList = canConfigure(account, "sys.mcp.list");
  const servers = useQuery({ queryKey: SETTINGS_MCP_KEY, queryFn: () => loadConsoleMcpServers(client), enabled: connected && active && canList });
  useSettingsDirty(name !== "" || url !== "" || transport !== "auto", onDirty);
  const add = useMutation({
    mutationFn: () => addConsoleMcpServer(client, { name, url, transport }),
    onSuccess: async () => { setName(""); setUrl(""); setTransport("auto"); await cache.invalidateQueries({ queryKey: SETTINGS_MCP_KEY }); },
  });
  const change = useMutation({
    mutationFn: async (input: { id: string; action: "remove" | "refresh" }) => {
      if (input.action === "remove") {
        const result = await removeConsoleMcpServer(client, input.id);
        if (!result.removed) throw new Error("The integration was not removed. Refresh and try again.");
      } else {
        await refreshConsoleMcpServer(client, input.id);
      }
    },
    onSuccess: async () => { setRemoveId(null); await cache.invalidateQueries({ queryKey: SETTINGS_MCP_KEY }); },
  });
  return <section aria-labelledby="settings-integrations-title">
    <h1 id="settings-integrations-title">Integrations</h1>
    <p class="settings-intro">Connect messaging and tools to your Ship.</p>
    <Telegram />
    <h2>MCP servers</h2>
    {!canList && <p class="settings-muted">Your account cannot list integrations.</p>}
    <SettingsError error={servers.error ?? change.error} />
    {servers.isPending && connected && canList && <LoadingState variant="panel">Loading integrations…</LoadingState>}
    <ul class="settings-list">{servers.data?.map((server) => {
      const own = account.uid === 0 || server.uid === account.uid;
      const auth = signInUrl(server.authUrl);
      return <li key={server.serverId}>
        <div class="settings-server-heading"><strong>{server.name}</strong><span>{server.state}</span></div>
        <span class="settings-url">{server.url}</span>
        <small>{server.tools.length} tools · {server.resourceCount} resources · {server.promptCount} prompts{!own ? " · read only" : ""}</small>
        {server.error && <p class="settings-error">{server.error}</p>}
        <div class="settings-actions">
          {own && auth && <a class="ibtn" href={auth} target="_blank" rel="noopener noreferrer">sign in</a>}
          <button class="ibtn" disabled={!connected || !own || !canConfigure(account, "sys.mcp.refresh") || change.isPending} onClick={() => change.mutate({ id: server.serverId, action: "refresh" })}>refresh</button>
          {removeId === server.serverId ? <>
            <span>Remove this integration?</span>
            <button class="ibtn" disabled={!connected || change.isPending || !own || !canConfigure(account, "sys.mcp.remove")} onClick={() => change.mutate({ id: server.serverId, action: "remove" })}>confirm remove</button>
            <button class="ibtn" disabled={change.isPending} onClick={() => setRemoveId(null)}>keep</button>
          </> : <button class="ibtn" disabled={!connected || !own || !canConfigure(account, "sys.mcp.remove") || change.isPending} onClick={() => setRemoveId(server.serverId)}>remove</button>}
        </div>
      </li>;
    })}</ul>
    {servers.data?.length === 0 && <p>No MCP servers are connected.</p>}
    <h2>Add an MCP server</h2>
    {!canConfigure(account, "sys.mcp.add") && <p class="settings-muted">Your account cannot add integrations.</p>}
    <SettingsError error={add.error} />
    <form onSubmit={(event) => { event.preventDefault(); if (connected && canConfigure(account, "sys.mcp.add")) add.mutate(); }}>
      <fieldset disabled={!connected || !canConfigure(account, "sys.mcp.add") || add.isPending}>
        <label>Name<input value={name} required onInput={(event) => setName(event.currentTarget.value)} placeholder="My tools" /></label>
        <label>Server URL<input type="url" value={url} required onInput={(event) => setUrl(event.currentTarget.value)} placeholder="https://example.com/mcp" /></label>
        <label>Transport<select value={transport} onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === "auto" || value === "streamable-http" || value === "sse") setTransport(value);
        }}><option value="auto">automatic</option><option value="streamable-http">streamable HTTP</option><option value="sse">server-sent events</option></select></label>
        <button class="ibtn" type="submit" disabled={!name.trim() || !signInUrl(url)}>{add.isPending ? <LoadingState>adding…</LoadingState> : "add server"}</button>
      </fieldset>
    </form>
  </section>;
}
