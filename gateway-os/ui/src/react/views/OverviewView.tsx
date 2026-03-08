import { getGatewayUrl } from "../../ui/storage";
import { useReactUiStore } from "../state/store";

function getUniqueNodes(tools: { name: string }[]): string[] {
  const nodes = new Set<string>();
  for (const tool of tools) {
    const parts = tool.name.split("__");
    if (parts.length === 2) {
      nodes.add(parts[0]);
    }
  }
  return Array.from(nodes);
}

export function OverviewView() {
  const connectionState = useReactUiStore((s) => s.connectionState);
  const settings = useReactUiStore((s) => s.settings);
  const tools = useReactUiStore((s) => s.tools);
  const sessions = useReactUiStore((s) => s.sessions);
  const channels = useReactUiStore((s) => s.channels);
  const chatMessages = useReactUiStore((s) => s.chatMessages);

  const nodeCount = getUniqueNodes(tools).length;
  const toolCount = tools.length;
  const gatewayUrl = getGatewayUrl(settings);

  return (
    <div className="view-container">
      <div className="cards-grid">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Connection</h3>
          </div>
          <div className="card-body">
            <div className="kv-list">
              <div className="kv-row">
                <span className="kv-key">Status</span>
                <span
                  className={`pill ${
                    connectionState === "connected" ? "pill-success" : "pill-warning"
                  }`}
                >
                  {connectionState}
                </span>
              </div>
              <div className="kv-row">
                <span className="kv-key">Gateway URL</span>
                <span className="kv-value mono">{gatewayUrl}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Nodes</h3>
          </div>
          <div className="card-body">
            <div className="stat">
              <div className="stat-value">{nodeCount}</div>
              <div className="stat-label">Connected Nodes</div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Tools</h3>
          </div>
          <div className="card-body">
            <div className="stat">
              <div className="stat-value">{toolCount}</div>
              <div className="stat-label">Available Tools</div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Sessions</h3>
          </div>
          <div className="card-body">
            <div className="stat">
              <div className="stat-value">{sessions.length}</div>
              <div className="stat-label">Active Sessions</div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Channels</h3>
          </div>
          <div className="card-body">
            <div className="stat">
              <div className="stat-value">{channels.length}</div>
              <div className="stat-label">Connected Channels</div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Current Session</h3>
          </div>
          <div className="card-body">
            <div className="kv-list">
              <div className="kv-row">
                <span className="kv-key">Session Key</span>
                <span className="kv-value mono truncate" style={{ maxWidth: 200 }}>
                  {settings.sessionKey}
                </span>
              </div>
              <div className="kv-row">
                <span className="kv-key">Messages</span>
                <span className="kv-value">{chatMessages.length}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
