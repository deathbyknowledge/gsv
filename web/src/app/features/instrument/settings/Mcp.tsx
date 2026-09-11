import { LoadingState } from "../../../components/ui/Spinner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { addConsoleMcpServer, loadConsoleMcpServers, refreshConsoleMcpServer, removeConsoleMcpServer } from "../../../services/system/consoleService";
import type { ConsoleMcpTransport } from "../../../domain/system/consoleModels";
import { canConfigure, SETTINGS_MCP_KEY, signInUrl } from "./settingsModel";
import { SettingsError, useSettingsDirty, type SettingsSectionProps } from "./settingsShared";
import { parseMcpHeaders, type McpHeaderDraft } from "./mcpHeaders";

export function Mcp({ account, active, onDirty }: SettingsSectionProps) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState<ConsoleMcpTransport>("auto");
  const [headers, setHeaders] = useState<McpHeaderDraft[]>([]);
  const parsedHeaders = parseMcpHeaders(headers);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const canList = canConfigure(account, "sys.mcp.list");
  const servers = useQuery({ queryKey: SETTINGS_MCP_KEY, queryFn: () => loadConsoleMcpServers(client), enabled: connected && active && canList });
  const dirty = name !== "" || url !== "" || transport !== "auto" || headers.some((header) => header.name !== "" || header.value !== "");
  useSettingsDirty(dirty, onDirty);
  const add = useMutation({
    mutationFn: () => {
      if (!parsedHeaders.ok) throw new Error(parsedHeaders.error);
      return addConsoleMcpServer(client, { name, url, transport, headers: parsedHeaders.headers });
    },
    onSuccess: async () => { setName(""); setUrl(""); setTransport("auto"); setHeaders([]); setAdding(false); await cache.invalidateQueries({ queryKey: SETTINGS_MCP_KEY }); },
  });
  const change = useMutation({
    mutationFn: async (input: { id: string; action: "remove" | "refresh" }) => {
      if (input.action === "remove") {
        const result = await removeConsoleMcpServer(client, input.id);
        if (!result.removed) throw new Error("The MCP server was not removed. Refresh and try again.");
      } else {
        await refreshConsoleMcpServer(client, input.id);
      }
    },
    onSuccess: async () => { setRemoveId(null); await cache.invalidateQueries({ queryKey: SETTINGS_MCP_KEY }); },
  });
  return <section aria-labelledby="settings-mcp-title">
    <h1 id="settings-mcp-title">MCP servers</h1>
    <p class="settings-intro">Connect tools and resources to your Ship.</p>
    {!canList && <p class="settings-muted">Your account cannot list MCP servers.</p>}
    <SettingsError error={servers.error ?? change.error} />
    {servers.isPending && connected && canList && <LoadingState variant="panel">Loading MCP servers…</LoadingState>}
    <ul class="settings-list">{servers.data?.map((server) => {
      const own = account.uid === 0 || server.uid === account.uid;
      const auth = signInUrl(server.authUrl);
      return <li key={server.serverId}>
        <div class="settings-server-heading"><strong>{server.name}</strong><span>{server.state}</span></div>
        <span class="settings-url">{server.url}</span>
        <small>{server.tools.length} tools · {server.resourceCount} resources · {server.promptCount} prompts{!own ? " · read only" : ""}</small>
        {server.error && <p class="settings-error">{server.error}</p>}
        <div class="settings-actions">
          {own && auth && <a class="settings-text-action" href={auth} target="_blank" rel="noopener noreferrer">sign in</a>}
          <button class="settings-text-action" disabled={!connected || !own || !canConfigure(account, "sys.mcp.refresh") || change.isPending} onClick={() => change.mutate({ id: server.serverId, action: "refresh" })}>refresh</button>
          {removeId === server.serverId ? <>
            <span>Remove this MCP server?</span>
            <button class="settings-text-action settings-danger" disabled={!connected || change.isPending || !own || !canConfigure(account, "sys.mcp.remove")} onClick={() => change.mutate({ id: server.serverId, action: "remove" })}>confirm remove</button>
            <button class="settings-text-action" disabled={change.isPending} onClick={() => setRemoveId(null)}>keep</button>
          </> : <button class="settings-text-action settings-danger" disabled={!connected || !own || !canConfigure(account, "sys.mcp.remove") || change.isPending} onClick={() => setRemoveId(server.serverId)}>remove</button>}
        </div>
      </li>;
    })}</ul>
    {servers.data?.length === 0 && <p>No MCP servers are connected.</p>}
    {!canConfigure(account, "sys.mcp.add") && <p class="settings-muted">Your account cannot add MCP servers.</p>}
    {!adding ? <button class="settings-text-action" type="button" disabled={!connected || !canConfigure(account, "sys.mcp.add")} onClick={() => { add.reset(); setAdding(true); }}>add MCP server</button> : <div class="settings-mcp-create">
    <div class="settings-instruction-heading"><h2>New MCP server</h2><button class="settings-text-action" type="button" disabled={add.isPending} onClick={() => {
      if (dirty && !window.confirm("Discard this new MCP server?")) return;
      setName(""); setUrl(""); setTransport("auto"); setHeaders([]); setAdding(false); add.reset();
    }}>cancel</button></div>
    <SettingsError error={add.error} />
    <form aria-label="New MCP server" onSubmit={(event) => { event.preventDefault(); if (connected && !add.isPending && canConfigure(account, "sys.mcp.add")) add.mutate(); }}>
      <fieldset disabled={!connected || !canConfigure(account, "sys.mcp.add") || add.isPending}>
        <label>Name<input autoFocus value={name} required onInput={(event) => setName(event.currentTarget.value)} placeholder="My tools" /></label>
        <label>Server URL<input type="url" value={url} required onInput={(event) => setUrl(event.currentTarget.value)} placeholder="https://example.com/mcp" /></label>
        <label>Transport<select value={transport} onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === "auto" || value === "streamable-http" || value === "sse") setTransport(value);
        }}><option value="auto">automatic</option><option value="streamable-http">streamable HTTP</option><option value="sse">server-sent events</option></select></label>
        <details class="settings-mcp-options">
          <summary>Custom headers{headers.some((header) => header.name || header.value) ? ` · ${headers.filter((header) => header.name || header.value).length}` : ""}</summary>
          <p class="settings-muted">For servers that need an API key or another HTTP header.</p>
          {headers.map((header, index) => <div class="settings-mcp-header" key={header.id}>
            <label>Header name<input aria-label={`Header ${index + 1} name`} value={header.name} placeholder="Authorization" autoComplete="off" spellcheck={false} onInput={(event) => { const name = event.currentTarget.value; setHeaders((rows) => rows.map((row) => row.id === header.id ? { ...row, name } : row)); }} /></label>
            <label>Header value<input aria-label={`Header ${index + 1} value`} type="password" value={header.value} placeholder="Value" autoComplete="off" spellcheck={false} onInput={(event) => { const value = event.currentTarget.value; setHeaders((rows) => rows.map((row) => row.id === header.id ? { ...row, value } : row)); }} /></label>
            <button class="settings-text-action" type="button" aria-label={`Remove header ${index + 1}`} onClick={() => setHeaders((rows) => rows.filter((row) => row.id !== header.id))}>remove</button>
          </div>)}
          {!parsedHeaders.ok && <p class="settings-error" role="alert">{parsedHeaders.error}</p>}
          <button class="settings-text-action" type="button" onClick={() => setHeaders((rows) => [...rows, { id: crypto.randomUUID(), name: "", value: "" }])}>add header</button>
        </details>
        <button class="ibtn" type="submit" disabled={!name.trim() || !signInUrl(url) || !parsedHeaders.ok}>{add.isPending ? <LoadingState>adding…</LoadingState> : "add server"}</button>
      </fieldset>
    </form>
    </div>}
  </section>;
}
