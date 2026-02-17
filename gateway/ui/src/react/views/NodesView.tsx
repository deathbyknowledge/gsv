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

  return Array.from(nodeMap.entries()).map(([id, toolsForNode]) => ({
    id,
    tools: toolsForNode,
  }));
}

function ToolList({
  tools,
  showShortName,
}: {
  tools: ToolDefinition[];
  showShortName: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      {tools.map((tool) => {
        const displayName = showShortName
          ? tool.name.split("__")[1] || tool.name
          : tool.name;
        return (
          <div
            key={tool.name}
            style={{
              display: "flex",
              flexDirection: "column",
              padding: "var(--space-2)",
              background: "var(--bg-tertiary)",
              borderRadius: "var(--radius-md)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
              <code style={{ fontSize: "var(--font-size-sm)", color: "var(--accent-primary)" }}>
                {displayName}
              </code>
            </div>
            <p
              style={{
                fontSize: "var(--font-size-xs)",
                color: "var(--text-muted)",
                marginTop: "var(--space-1)",
              }}
            >
              {tool.description}
            </p>
          </div>
        );
      })}
    </div>
  );
}

export function NodesView() {
  const tools = useReactUiStore((s) => s.tools);
  const toolsLoading = useReactUiStore((s) => s.toolsLoading);
  const loadTools = useReactUiStore((s) => s.loadTools);

  const nodes = groupToolsByNode(tools);
  const nativeTools = tools.filter((t) => t.name.startsWith("gsv__"));

  return (
    <div className="view-container">
      <div className="section-header">
        <h2 className="section-title">Connected Nodes</h2>
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

      {toolsLoading && tools.length === 0 ? (
        <div className="card">
          <div className="card-body">
            <div className="thinking-indicator">
              <span className="spinner"></span>
              <span>Loading nodes...</span>
            </div>
          </div>
        </div>
      ) : nodes.length === 0 && nativeTools.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">🖥️</div>
          <h3 className="empty-state-title">No nodes connected</h3>
          <p className="empty-state-description">
            Connect a node using: <code>gsv node</code>
          </p>
        </div>
      ) : (
        <>
          {nativeTools.length > 0 ? (
            <div className="card" style={{ marginBottom: "var(--space-4)" }}>
              <div className="card-header">
                <h3 className="card-title">
                  <span style={{ marginRight: "var(--space-2)" }}>🚀</span>
                  Native Tools (Gateway)
                </h3>
                <span className="pill">{nativeTools.length} tools</span>
              </div>
              <div className="card-body">
                <ToolList tools={nativeTools} showShortName={false} />
              </div>
            </div>
          ) : null}

          {nodes.map((node) => (
            <div className="card" style={{ marginBottom: "var(--space-4)" }} key={node.id}>
              <div className="card-header">
                <h3 className="card-title">
                  <span style={{ marginRight: "var(--space-2)" }}>🖥️</span>
                  {node.id}
                </h3>
                <span className="pill pill-success">{node.tools.length} tools</span>
              </div>
              <div className="card-body">
                <ToolList tools={node.tools} showShortName={true} />
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
