import { LoadingState } from "../../../components/ui/Spinner";
import { Select } from "../../../components/ui/Select";
import { TextInput } from "../../../components/ui/TextInput";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { addConsoleMcpServer, loadConsoleMcpServers, refreshConsoleMcpServer, removeConsoleMcpServer } from "../../../services/system/consoleService";
import type { ConsoleMcpTransport } from "../../../domain/system/consoleModels";
import { canConfigure, SETTINGS_MCP_KEY, signInUrl } from "./settingsModel";
import { SettingsError, useSettingsDirty, type SettingsSectionProps } from "./settingsShared";
import { parseMcpHeaders, type McpHeaderDraft } from "./mcpHeaders";
import { useT } from "../../../i18n/locale";

export function Mcp({ account, active, onDirty }: SettingsSectionProps) {
  const t = useT();
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
        if (!result.removed) throw new Error(t("settings.mcp.notRemoved"));
      } else {
        await refreshConsoleMcpServer(client, input.id);
      }
    },
    onSuccess: async () => { setRemoveId(null); await cache.invalidateQueries({ queryKey: SETTINGS_MCP_KEY }); },
  });
  return <section aria-labelledby="settings-mcp-title">
    <h1 id="settings-mcp-title">{t("settings.mcp.title")}</h1>
    <p class="settings-intro">{t("settings.mcp.intro")}</p>
    {!canList && <p class="settings-muted">{t("settings.mcp.noList")}</p>}
    <SettingsError error={servers.error ?? change.error} />
    {servers.isPending && connected && canList && <LoadingState variant="panel">{t("settings.mcp.loading")}</LoadingState>}
    <ul class="settings-list">{servers.data?.map((server) => {
      const own = account.uid === 0 || server.uid === account.uid;
      const auth = signInUrl(server.authUrl);
      return <li key={server.serverId}>
        <div class="settings-server-heading"><strong>{server.name}</strong><span>{server.state}</span></div>
        <span class="settings-url">{server.url}</span>
        <small>{t("settings.mcp.tools", { count: server.tools.length })} · {t("settings.mcp.resources", { count: server.resourceCount })} · {t("settings.mcp.prompts", { count: server.promptCount })}{!own ? ` · ${t("settings.mcp.readOnly")}` : ""}</small>
        {server.error && <p class="settings-error">{server.error}</p>}
        <div class="settings-actions">
          {own && auth && <a class="settings-text-action" href={auth} target="_blank" rel="noopener noreferrer">{t("settings.mcp.signIn")}</a>}
          <button class="settings-text-action" disabled={!connected || !own || !canConfigure(account, "sys.mcp.refresh") || change.isPending} onClick={() => change.mutate({ id: server.serverId, action: "refresh" })}>{t("common.refresh")}</button>
          {removeId === server.serverId ? <>
            <span>{t("settings.mcp.confirmRemove")}</span>
            <button class="settings-text-action settings-danger" disabled={!connected || change.isPending || !own || !canConfigure(account, "sys.mcp.remove")} onClick={() => change.mutate({ id: server.serverId, action: "remove" })}>{t("settings.mcp.confirm")}</button>
            <button class="settings-text-action" disabled={change.isPending} onClick={() => setRemoveId(null)}>{t("settings.mcp.keep")}</button>
          </> : <button class="settings-text-action settings-danger" disabled={!connected || !own || !canConfigure(account, "sys.mcp.remove") || change.isPending} onClick={() => setRemoveId(server.serverId)}>{t("common.remove")}</button>}
        </div>
      </li>;
    })}</ul>
    {servers.data?.length === 0 && <p>{t("settings.mcp.none")}</p>}
    {!canConfigure(account, "sys.mcp.add") && <p class="settings-muted">{t("settings.mcp.noAdd")}</p>}
    {!adding ? <button class="settings-text-action" type="button" disabled={!connected || !canConfigure(account, "sys.mcp.add")} onClick={() => { add.reset(); setAdding(true); }}>{t("settings.mcp.add")}</button> : <div class="settings-mcp-create">
    <div class="settings-instruction-heading"><h2>{t("settings.mcp.newTitle")}</h2><button class="settings-text-action" type="button" disabled={add.isPending} onClick={() => {
      if (dirty && !window.confirm(t("settings.mcp.confirmDiscard"))) return;
      setName(""); setUrl(""); setTransport("auto"); setHeaders([]); setAdding(false); add.reset();
    }}>{t("common.cancel")}</button></div>
    <SettingsError error={add.error} />
    <form aria-label={t("settings.mcp.newTitle")} onSubmit={(event) => { event.preventDefault(); if (connected && !add.isPending && canConfigure(account, "sys.mcp.add")) add.mutate(); }}>
      <fieldset disabled={!connected || !canConfigure(account, "sys.mcp.add") || add.isPending}>
        <TextInput label={t("settings.mcp.name")} placeholder={t("settings.mcp.namePlaceholder")} value={name} requirement="required" onChange={setName} inputProps={{ autoFocus: true, required: true }} />
        <TextInput label={t("settings.mcp.url")} placeholder="https://example.com/mcp" type="url" value={url} requirement="required" onChange={setUrl} inputProps={{ required: true }} />
        <Select block label={t("settings.mcp.transport")} selected={transport} options={[
          { label: t("settings.mcp.transportAuto"), value: "auto" },
          { label: t("settings.mcp.transportStreamable"), value: "streamable-http" },
          { label: t("settings.mcp.transportSse"), value: "sse" },
        ]} onSelect={(value) => {
          if (value === "auto" || value === "streamable-http" || value === "sse") setTransport(value);
        }} />
        <details class="settings-mcp-options">
          <summary>{t("settings.mcp.headers")}{headers.some((header) => header.name || header.value) ? ` · ${headers.filter((header) => header.name || header.value).length}` : ""}</summary>
          <p class="settings-muted">{t("settings.mcp.headersHint")}</p>
          {headers.map((header, index) => <div class="settings-mcp-header" key={header.id}>
            <TextInput label={t("settings.mcp.headerName")} placeholder="Authorization" value={header.name} inputProps={{ "aria-label": t("settings.mcp.headerNameLabel", { number: index + 1 }), autoComplete: "off", spellcheck: false }} onChange={(name) => setHeaders((rows) => rows.map((row) => row.id === header.id ? { ...row, name } : row))} />
            <TextInput label={t("settings.mcp.headerValue")} placeholder={t("settings.mcp.valuePlaceholder")} type="password" value={header.value} inputProps={{ "aria-label": t("settings.mcp.headerValueLabel", { number: index + 1 }), autoComplete: "off", spellcheck: false }} onChange={(value) => setHeaders((rows) => rows.map((row) => row.id === header.id ? { ...row, value } : row))} />
            <button class="settings-text-action" type="button" aria-label={t("settings.mcp.removeHeader", { number: index + 1 })} onClick={() => setHeaders((rows) => rows.filter((row) => row.id !== header.id))}>{t("common.remove")}</button>
          </div>)}
          {!parsedHeaders.ok && <p class="settings-error" role="alert">{parsedHeaders.error}</p>}
          <button class="settings-text-action" type="button" onClick={() => setHeaders((rows) => [...rows, { id: crypto.randomUUID(), name: "", value: "" }])}>{t("settings.mcp.addHeader")}</button>
        </details>
        <button class="ibtn" type="submit" disabled={!name.trim() || !signInUrl(url) || !parsedHeaders.ok}>{add.isPending ? <LoadingState>{t("settings.mcp.adding")}</LoadingState> : t("settings.mcp.addServer")}</button>
      </fieldset>
    </form>
    </div>}
  </section>;
}
