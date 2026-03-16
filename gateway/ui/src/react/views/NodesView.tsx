import { Button } from "@cloudflare/kumo/components/button";
import type { ToolDefinition } from "../../ui/types";
import { useReactUiStore } from "../state/store";

type NodeInfo = {
  id: string;
  tools: ToolDefinition[];
};

function groupToolsByNode(tools: ToolDefinition[]): NodeInfo[] {
  const nodeMap = new Map<string, ToolDefinition[]>();

  for (const tool of tools) {
    if (tool.name.startsWith("gsv__")) continue;
    const parts = tool.name.split("__");
    if (parts.length !== 2) continue;

    const nodeId = parts[0];
    if (!nodeMap.has(nodeId)) {
      nodeMap.set(nodeId, []);
    }
    nodeMap.get(nodeId)!.push(tool);
  }

  return Array.from(nodeMap.entries())
    .map(([id, toolsForNode]) => ({ id, tools: toolsForNode }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function toolShortName(toolName: string): string {
  return toolName.split("__")[1] || toolName;
}

export function NodesView() {
  const tools = useReactUiStore((s) => s.tools);
  const toolsLoading = useReactUiStore((s) => s.toolsLoading);
  const loadTools = useReactUiStore((s) => s.loadTools);

  const nodes = groupToolsByNode(tools);
  const nativeTools = tools.filter((tool) => tool.name.startsWith("gsv__"));

  return (
    <div className="view-container">
      <div className="app-shell" data-app="nodes">
        <section className="app-hero">
          <div className="app-hero-content">
            <div>
              <h2 className="app-hero-title">Node Inventory</h2>
              <p className="app-hero-subtitle">
                Inspect active execution hosts and the tools each host currently
                exposes to the gateway runtime.
              </p>
              <div className="app-hero-meta">
                <span className="app-badge-dot" />
                <span>{nodes.length} node(s) online</span>
                <span className="app-mono-pill mono">{tools.length} total tools</span>
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              loading={toolsLoading}
              onClick={() => {
                void loadTools();
              }}
            >
              Refresh
            </Button>
          </div>
        </section>

        {toolsLoading && tools.length === 0 ? (
          <section className="app-panel">
            <div className="app-panel-body app-empty">
              <div>
                <span className="spinner" />
                <div style={{ marginTop: "var(--space-2)" }}>Loading node inventory...</div>
              </div>
            </div>
          </section>
        ) : nodes.length === 0 && nativeTools.length === 0 ? (
          <section className="app-panel">
            <div className="app-panel-body app-empty">
              <div>
                <div className="app-empty-icon">🖥️</div>
                <div>No nodes connected</div>
                <div className="text-secondary" style={{ marginTop: "var(--space-1)" }}>
                  Connect one with <code>gsv node --foreground</code>.
                </div>
              </div>
            </div>
          </section>
        ) : (
          <section className="app-grid">
            {nativeTools.length > 0 ? (
              <article className="app-panel app-col-12">
                <header className="app-panel-head">
                  <h3 className="app-panel-title">Gateway Native Tools</h3>
                  <span className="app-panel-meta">{nativeTools.length}</span>
                </header>
                <div className="app-panel-body">
                  <div className="app-list">
                    {nativeTools.map((tool) => (
                      <div className="app-list-item" key={tool.name}>
                        <div className="app-list-title mono">{tool.name}</div>
                        <div className="app-list-subtitle">{tool.description}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </article>
            ) : null}

            {nodes.map((node) => (
              <article className="app-panel app-col-6" key={node.id}>
                <header className="app-panel-head">
                  <h3 className="app-panel-title">
                    <span style={{ marginRight: "var(--space-2)" }}>🖥️</span>
                    {node.id}
                  </h3>
                  <span className="pill pill-success">{node.tools.length} tools</span>
                </header>
                <div className="app-panel-body">
                  <div className="app-list">
                    {node.tools.map((tool) => (
                      <div className="app-list-item" key={tool.name}>
                        <div className="app-list-title mono">{toolShortName(tool.name)}</div>
                        <div className="app-list-subtitle">{tool.description}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </article>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
