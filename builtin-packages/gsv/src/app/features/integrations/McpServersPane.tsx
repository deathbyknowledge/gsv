import type { ComponentChildren } from "preact";
import { ActionButton } from "../../components/ui/ActionButton";
import {
  MCP_TRANSPORT_OPTIONS,
  attentionServerCount,
  describeMcpState,
  formatServerUrl,
  formatShortDate,
  readyServerCount,
  stateLabel,
  stateTone,
  transportLabel,
} from "./mcp-domain";
import type { McpServer, McpTool, McpTransportType } from "./types";
import type { McpServersRuntime } from "./useMcpServers";

export function McpServersSummary({ runtime, onBack }: { runtime: McpServersRuntime; onBack?: () => void }) {
  const addDisabled = runtime.pendingAction === "mcp:add" || !runtime.form.name.trim() || !runtime.form.url.trim();
  return (
    <section class="gsv-mcp-summary">
      <header>
        {onBack ? <ActionButton icon="arrow-left" label="Integrations" onClick={onBack} /> : null}
        <div>
          <h4>MCP servers</h4>
          <p>Connect tool servers that agents can use through CodeMode.</p>
        </div>
      </header>

      <form
        class="gsv-integration-form gsv-mcp-add"
        onSubmit={(event) => {
          event.preventDefault();
          if (addDisabled) return;
          void runtime.addServer();
        }}
      >
        <label>
          <span>Name</span>
          <input
            type="text"
            value={runtime.form.name}
            placeholder="GitHub"
            onInput={(event) => {
              const target = event.currentTarget as HTMLInputElement;
              runtime.setForm((current) => ({ ...current, name: target.value }));
            }}
          />
        </label>
        <label>
          <span>Server URL</span>
          <input
            type="url"
            value={runtime.form.url}
            placeholder="https://example.com/mcp"
            onInput={(event) => {
              const target = event.currentTarget as HTMLInputElement;
              runtime.setForm((current) => ({ ...current, url: target.value }));
            }}
          />
        </label>
        <label>
          <span>Transport</span>
          <select
            value={runtime.form.transport}
            onChange={(event) => {
              const target = event.currentTarget as HTMLSelectElement;
              runtime.setForm((current) => ({ ...current, transport: target.value as McpTransportType }));
            }}
          >
            {MCP_TRANSPORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <ActionButton
          type="submit"
          icon="plug"
          label="Connect server"
          busyLabel="Connecting"
          busy={runtime.pendingAction === "mcp:add"}
          disabled={addDisabled}
          size="full"
        />
      </form>

      <div class="gsv-mcp-counts">
        <span>{runtime.state.servers.length} servers</span>
        <span>{readyServerCount(runtime.state.servers)} ready</span>
        <span>{attentionServerCount(runtime.state.servers)} need attention</span>
      </div>

      <div class="gsv-mcp-list" aria-label="MCP servers">
        {runtime.loading ? (
          <div class="gsv-empty-state">Loading MCP servers...</div>
        ) : runtime.state.servers.length === 0 ? (
          <div class="gsv-empty-state">No MCP servers connected.</div>
        ) : (
          runtime.state.servers.map((server) => (
            <button
              key={server.serverId}
              type="button"
              class={`gsv-mcp-row${runtime.selectedServerId === server.serverId ? " is-selected" : ""}`}
              onClick={() => runtime.setSelectedServerId(server.serverId)}
            >
              <span class="gsv-row-copy">
                <strong>{server.name}</strong>
                <span>{formatServerUrl(server.url)}</span>
              </span>
              <StatusPill server={server} />
            </button>
          ))
        )}
      </div>
    </section>
  );
}

export function McpServersDetail({ runtime, onBack }: { runtime: McpServersRuntime; onBack?: () => void }) {
  const server = runtime.selectedServer;
  if (runtime.loading) {
    return (
      <section class="gsv-integration-detail">
        <div class="gsv-empty-state">
          <h3>MCP servers</h3>
          <p>Loading server inventory...</p>
        </div>
      </section>
    );
  }

  if (!server) {
    return (
      <section class="gsv-integration-detail">
        <header class="gsv-integration-detail-head">
          <div>
            <span class="gsv-kicker">MCP</span>
            <h3>No server selected</h3>
            <p>Connect a server to make MCP tools available to agents through CodeMode.</p>
          </div>
        </header>
        {runtime.error ? <p class="gsv-inline-error">{runtime.error}</p> : null}
      </section>
    );
  }

  const refreshAction = `mcp:refresh:${server.serverId}`;
  const removeAction = `mcp:remove:${server.serverId}`;
  const state = describeMcpState(server);

  return (
    <section class="gsv-integration-detail" aria-label={`${server.name} MCP server`}>
      <header class="gsv-integration-detail-head">
        {onBack ? <ActionButton icon="arrow-left" label="MCP servers" onClick={onBack} /> : null}
        <div>
          <span class="gsv-kicker">MCP</span>
          <h3>{server.name}</h3>
          <p>{formatServerUrl(server.url)}</p>
        </div>
        <StatusPill server={server} />
      </header>

      {runtime.error ? <p class="gsv-inline-error">{runtime.error}</p> : null}
      {runtime.notice ? <p class="gsv-inline-status">{runtime.notice}</p> : null}

      <div class="gsv-integration-body">
        <section class="gsv-integration-panel gsv-mcp-status-panel">
          <header>
            <div>
              <h4>{state.title}</h4>
              <p>{state.detail}</p>
            </div>
          </header>
          {server.state === "authenticating" && server.authUrl ? (
            <div class="gsv-mcp-auth-flow">
              <ActionButton icon="external" label="Continue sign-in" size="full" onClick={() => runtime.openSignIn(server)} />
              <ActionButton
                icon="refresh"
                label="Check connection"
                busyLabel="Checking"
                busy={runtime.pendingAction === refreshAction}
                size="full"
                onClick={() => void runtime.refreshServer(server.serverId)}
              />
              {runtime.signInOpenedFor === server.serverId ? (
                <p class="gsv-runtime-meta">Waiting for the browser flow to finish.</p>
              ) : null}
            </div>
          ) : null}
        </section>

        <div class="gsv-mcp-facts">
          <article class="gsv-info-box">
            <span>Transport</span>
            <strong>{transportLabel(server.transport)}</strong>
          </article>
          <article class="gsv-info-box">
            <span>Tools</span>
            <strong>{server.tools.length}</strong>
          </article>
          <article class="gsv-info-box">
            <span>Resources</span>
            <strong>{server.resourceCount}</strong>
          </article>
          <article class="gsv-info-box">
            <span>Prompts</span>
            <strong>{server.promptCount}</strong>
          </article>
        </div>

        {server.instructions ? (
          <section class="gsv-integration-panel">
            <header>
              <h4>Server instructions</h4>
            </header>
            <p>{server.instructions}</p>
          </section>
        ) : null}

        <section class="gsv-integration-panel">
          <header>
            <div>
              <h4>Tools</h4>
              <p>Visible to agents as generated CodeMode functions.</p>
            </div>
          </header>
          <ToolInventory tools={server.tools} />
        </section>

        <section class="gsv-integration-panel gsv-mcp-actions">
          <p>Connected {formatShortDate(server.createdAt)}. Last refreshed {formatShortDate(server.updatedAt)}.</p>
          <div>
            <ActionButton
              icon="refresh"
              label="Refresh"
              busyLabel="Refreshing"
              busy={runtime.pendingAction === refreshAction}
              size="full"
              onClick={() => void runtime.refreshServer(server.serverId)}
            />
            <ActionButton
              icon="trash"
              label="Remove"
              busyLabel="Removing"
              busy={runtime.pendingAction === removeAction}
              variant="danger"
              size="full"
              onClick={() => {
                if (!window.confirm(`Remove MCP server ${server.name}?`)) return;
                void runtime.removeServer(server.serverId);
              }}
            />
          </div>
        </section>
      </div>
    </section>
  );
}

function ToolInventory({ tools }: { tools: McpTool[] }) {
  if (tools.length === 0) {
    return <div class="gsv-empty-state">No tools discovered yet.</div>;
  }

  return (
    <div class="gsv-tool-list" aria-label="MCP tools">
      {tools.map((tool) => (
        <article class="gsv-tool-row" key={tool.name}>
          <div class="gsv-tool-title">
            <strong><code>{tool.name}</code></strong>
            {tool.description ? <span>{tool.description}</span> : null}
          </div>
          <ToolField label="Arguments">
            <FieldChips
              fields={tool.inputFields}
              requiredFields={tool.requiredInputFields}
              fallback={tool.hasInputSchema ? "object" : "not declared"}
            />
          </ToolField>
          <ToolField label="Output">
            <FieldChips
              fields={tool.outputFields}
              requiredFields={[]}
              fallback={tool.hasOutputSchema ? "structured" : "not declared"}
            />
          </ToolField>
        </article>
      ))}
    </div>
  );
}

function ToolField({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="gsv-tool-field">
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
    return <span class="gsv-tool-fallback">{fallback}</span>;
  }
  return (
    <span class="gsv-chip-row">
      {fields.map((field) => (
        <span key={field} class={`gsv-chip${requiredFields.includes(field) ? " is-required" : ""}`}>
          {field}
        </span>
      ))}
    </span>
  );
}

function StatusPill({ server }: { server: McpServer }) {
  return (
    <span class={`gsv-state-pill ${stateTone(server.state)}`}>
      {stateLabel(server.state)}
    </span>
  );
}
