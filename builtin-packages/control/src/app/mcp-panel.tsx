import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type {
  AddMcpServerArgs,
  ControlMcpServer,
  ControlMcpTool,
  ControlMcpTransportType,
} from "./types";

type McpPanelProps = {
  servers: ControlMcpServer[];
  selectedServerId: string | null;
  pendingAction: string | null;
  onSelectServer: (serverId: string | null) => void;
  onAddServer: (args: AddMcpServerArgs) => Promise<ControlMcpServer | null>;
  onRefreshServer: (serverId: string) => Promise<void>;
  onRemoveServer: (serverId: string) => Promise<void>;
};

const TRANSPORT_OPTIONS: Array<{ value: ControlMcpTransportType; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "streamable-http", label: "Streamable HTTP" },
  { value: "sse", label: "SSE" },
];

export function McpPanel({
  servers,
  selectedServerId,
  pendingAction,
  onSelectServer,
  onAddServer,
  onRefreshServer,
  onRemoveServer,
}: McpPanelProps) {
  const [form, setForm] = useState<AddMcpServerArgs>({
    name: "",
    url: "",
    transport: "auto",
  });
  const [signInOpenedFor, setSignInOpenedFor] = useState<string | null>(null);
  const selectedServer = useMemo(
    () => servers.find((server) => server.serverId === selectedServerId) ?? servers[0] ?? null,
    [selectedServerId, servers],
  );
  const authenticatingCount = servers.filter((server) => server.state === "authenticating").length;

  useEffect(() => {
    if (servers.length === 0) {
      if (selectedServerId !== null) {
        onSelectServer(null);
      }
      return;
    }
    if (!selectedServerId || !servers.some((server) => server.serverId === selectedServerId)) {
      onSelectServer(servers[0].serverId);
    }
  }, [onSelectServer, selectedServerId, servers]);

  useEffect(() => {
    if (!signInOpenedFor) {
      return;
    }
    const onFocus = () => {
      void onRefreshServer(signInOpenedFor);
      setSignInOpenedFor(null);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [onRefreshServer, signInOpenedFor]);

  const addDisabled = pendingAction === "mcp:add" || !form.name.trim() || !form.url.trim();

  return (
    <div class={`control-mcp-stage${selectedServer ? " has-selection" : ""}`}>
      <section class="control-mcp-rail">
        <header class="control-config-rail-head">
          <h2>MCP servers</h2>
          <p>Connect HTTP MCP servers for agents and CodeMode.</p>
        </header>

        <form
          class="control-mcp-add"
          onSubmit={(event) => {
            event.preventDefault();
            if (addDisabled) return;
            void onAddServer({
              ...form,
              callbackHost: window.location.origin,
            }).then((server) => {
              setForm({ name: "", url: "", transport: "auto" });
              if (server?.state === "authenticating" && server.authUrl) {
                window.open(server.authUrl, "_blank", "noopener,noreferrer");
                setSignInOpenedFor(server.serverId);
              }
            }).catch(() => {});
          }}
        >
          <label class="control-form-row">
            <span>Name</span>
            <input
              class="control-field"
              type="text"
              value={form.name}
              placeholder="GitHub"
              onInput={(event) => {
                const target = event.currentTarget as HTMLInputElement;
                setForm((current) => ({ ...current, name: target.value }));
              }}
            />
          </label>

          <label class="control-form-row">
            <span>Server URL</span>
            <input
              class="control-field"
              type="url"
              value={form.url}
              placeholder="https://example.com/mcp"
              onInput={(event) => {
                const target = event.currentTarget as HTMLInputElement;
                setForm((current) => ({ ...current, url: target.value }));
              }}
            />
          </label>

          <label class="control-form-row">
            <span>Transport</span>
            <select
              class="control-field"
              value={form.transport}
              onChange={(event) => {
                const target = event.currentTarget as HTMLSelectElement;
                setForm((current) => ({ ...current, transport: target.value as ControlMcpTransportType }));
              }}
            >
              {TRANSPORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <button class="control-button control-button--primary" type="submit" disabled={addDisabled}>
            {pendingAction === "mcp:add" ? "Connecting..." : "Connect server"}
          </button>
        </form>

        <div class="control-mcp-summary">
          <span>{servers.length} servers</span>
          <span>{authenticatingCount} need sign-in</span>
        </div>

        <div class="control-mcp-list">
          {servers.length === 0 ? (
            <div class="control-empty-block">No MCP servers connected.</div>
          ) : servers.map((server) => (
            <button
              key={server.serverId}
              class={`control-mcp-list-row${server.serverId === selectedServer?.serverId ? " is-active" : ""}`}
              type="button"
              onClick={() => onSelectServer(server.serverId)}
            >
              <span class="control-mcp-row-main">
                <strong>{server.name}</strong>
                <small>{formatServerUrl(server.url)}</small>
              </span>
              <StatusPill server={server} />
            </button>
          ))}
        </div>
      </section>

      <section class="control-mcp-detail">
        {selectedServer ? (
          <ServerDetail
            server={selectedServer}
            pendingAction={pendingAction}
            signInOpened={signInOpenedFor === selectedServer.serverId}
            onSignInOpened={() => setSignInOpenedFor(selectedServer.serverId)}
            onRefreshServer={onRefreshServer}
            onRemoveServer={onRemoveServer}
          />
        ) : (
          <div class="control-mcp-empty-detail">
            <h2>No server selected</h2>
            <p>Connect a server to make MCP tools available to agents through CodeMode.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function ServerDetail({
  server,
  pendingAction,
  signInOpened,
  onSignInOpened,
  onRefreshServer,
  onRemoveServer,
}: {
  server: ControlMcpServer;
  pendingAction: string | null;
  signInOpened: boolean;
  onSignInOpened: () => void;
  onRefreshServer: (serverId: string) => Promise<void>;
  onRemoveServer: (serverId: string) => Promise<void>;
}) {
  const refreshAction = `mcp:refresh:${server.serverId}`;
  const removeAction = `mcp:remove:${server.serverId}`;

  return (
    <div class="control-detail-pane">
      <header class="control-detail-head">
        <div>
          <h2>{server.name}</h2>
          <p>{formatServerUrl(server.url)}</p>
        </div>
        <StatusPill server={server} />
      </header>

      <div class="control-mcp-status-panel">
        <ConnectionState server={server} />
        {server.state === "authenticating" && server.authUrl ? (
          <div class="control-mcp-auth-flow">
            <strong>Sign in with the provider</strong>
            <p>Open the provider sign-in page. When the browser flow finishes, this server will be rediscovered.</p>
            <div class="control-actions-bar">
              <a
                class="control-button control-button--primary"
                href={server.authUrl}
                target="_blank"
                rel="noreferrer"
                onClick={onSignInOpened}
              >
                Continue sign-in
              </a>
              <button
                class="control-button"
                type="button"
                disabled={pendingAction === refreshAction}
                onClick={() => void onRefreshServer(server.serverId)}
              >
                {pendingAction === refreshAction ? "Checking..." : "Check connection"}
              </button>
            </div>
            {signInOpened ? <p class="control-field-note">Waiting for the browser flow to finish.</p> : null}
          </div>
        ) : null}
      </div>

      <div class="control-mcp-facts">
        <div>
          <span>Transport</span>
          <strong>{transportLabel(server.transport)}</strong>
        </div>
        <div>
          <span>Tools</span>
          <strong>{server.tools.length}</strong>
        </div>
        <div>
          <span>Resources</span>
          <strong>{server.resourceCount}</strong>
        </div>
        <div>
          <span>Prompts</span>
          <strong>{server.promptCount}</strong>
        </div>
      </div>

      {server.instructions ? (
        <section class="control-subsection">
          <h3>Server instructions</h3>
          <p class="control-subtle">{server.instructions}</p>
        </section>
      ) : null}

      <section class="control-subsection">
        <div class="control-detail-head control-detail-head--compact">
          <div>
            <h2>Tools</h2>
            <p>Visible to agents as generated CodeMode functions, not direct model tools.</p>
          </div>
        </div>
        <ToolTable tools={server.tools} />
      </section>

      <div class="control-section-actions">
        <p class="control-inline-note">Connected {formatDate(server.createdAt)}. Last refreshed {formatDate(server.updatedAt)}.</p>
        <div class="control-section-actions-group">
          <button
            class="control-button"
            type="button"
            disabled={pendingAction === refreshAction}
            onClick={() => void onRefreshServer(server.serverId)}
          >
            {pendingAction === refreshAction ? "Refreshing..." : "Refresh"}
          </button>
          <button
            class="control-button control-button--danger"
            type="button"
            disabled={pendingAction === removeAction}
            onClick={() => {
              if (!window.confirm(`Remove MCP server ${server.name}?`)) return;
              void onRemoveServer(server.serverId);
            }}
          >
            {pendingAction === removeAction ? "Removing..." : "Remove"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectionState({ server }: { server: ControlMcpServer }) {
  if (server.state === "ready") {
    return (
      <div>
        <strong>Ready for agents</strong>
        <p>MCP tools from this server are available through CodeMode with generated function names and type hints.</p>
      </div>
    );
  }

  if (server.state === "authenticating") {
    return (
      <div>
        <strong>Sign-in required</strong>
        <p>This server needs a browser OAuth flow before its tools can be used.</p>
      </div>
    );
  }

  if (server.state === "failed") {
    return (
      <div>
        <strong>Connection failed</strong>
        <p>{server.error ?? "Refresh the server after checking the endpoint and provider access."}</p>
      </div>
    );
  }

  return (
    <div>
      <strong>{stateLabel(server.state)}</strong>
      <p>The server is being connected or rediscovered. Refresh if this state does not settle.</p>
    </div>
  );
}

function ToolTable({ tools }: { tools: ControlMcpTool[] }) {
  if (tools.length === 0) {
    return <div class="control-empty-block">No tools discovered yet.</div>;
  }

  return (
    <>
      <div class="control-table-wrap control-table-wrap--flush">
        <table class="control-table">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Arguments</th>
              <th>Output</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((tool) => (
              <tr key={tool.name}>
                <td>
                  <code>{tool.name}</code>
                  {tool.description ? <div class="control-subtle">{tool.description}</div> : null}
                </td>
                <td>
                  <FieldChips
                    fields={tool.inputFields}
                    requiredFields={tool.requiredInputFields}
                    fallback={tool.hasInputSchema ? "object" : "not declared"}
                  />
                </td>
                <td>
                  <FieldChips
                    fields={tool.outputFields}
                    requiredFields={[]}
                    fallback={tool.hasOutputSchema ? "structured" : "not declared"}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div class="control-record-list control-record-list--flush" aria-label="MCP tools">
        {tools.map((tool) => (
          <article class="control-record" key={`tool-record:${tool.name}`}>
            <div class="control-record-head">
              <div class="control-record-title">
                <strong><code>{tool.name}</code></strong>
                {tool.description ? <span class="control-subtle">{tool.description}</span> : null}
              </div>
            </div>
            <div class="control-record-meta">
              <RecordField label="Arguments">
                <FieldChips
                  fields={tool.inputFields}
                  requiredFields={tool.requiredInputFields}
                  fallback={tool.hasInputSchema ? "object" : "not declared"}
                />
              </RecordField>
              <RecordField label="Output">
                <FieldChips
                  fields={tool.outputFields}
                  requiredFields={[]}
                  fallback={tool.hasOutputSchema ? "structured" : "not declared"}
                />
              </RecordField>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

function RecordField({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="control-record-field">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}

function FieldChips({
  fields,
  requiredFields,
  fallback,
}: {
  fields: string[];
  requiredFields: string[];
  fallback: string;
}) {
  if (fields.length === 0) {
    return <span class="control-subtle">{fallback}</span>;
  }
  return (
    <span class="control-chip-row">
      {fields.map((field) => (
        <span key={field} class={`control-chip${requiredFields.includes(field) ? " is-required" : ""}`}>
          {field}
        </span>
      ))}
    </span>
  );
}

function StatusPill({ server }: { server: ControlMcpServer }) {
  return <span class={`control-mcp-status is-${server.state}`}>{stateLabel(server.state)}</span>;
}

function stateLabel(state: ControlMcpServer["state"]): string {
  switch (state) {
    case "authenticating":
      return "Sign-in needed";
    case "connecting":
      return "Connecting";
    case "connected":
      return "Connected";
    case "discovering":
      return "Discovering";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
    default:
      return "Not connected";
  }
}

function transportLabel(transport: ControlMcpTransportType): string {
  return TRANSPORT_OPTIONS.find((option) => option.value === transport)?.label ?? transport;
}

function formatServerUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value;
  }
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
