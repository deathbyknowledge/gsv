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
  return Array.from(nodes).sort();
}

export function OverviewView() {
  const connectionState = useReactUiStore((s) => s.connectionState);
  const settings = useReactUiStore((s) => s.settings);
  const tools = useReactUiStore((s) => s.tools);
  const sessions = useReactUiStore((s) => s.sessions);
  const channels = useReactUiStore((s) => s.channels);
  const chatMessages = useReactUiStore((s) => s.chatMessages);

  const gatewayUrl = getGatewayUrl(settings);
  const nodes = getUniqueNodes(tools);
  const kpis = [
    { label: "Nodes", value: nodes.length },
    { label: "Tools", value: tools.length },
    { label: "Sessions", value: sessions.length },
    { label: "Channels", value: channels.length },
    { label: "Messages", value: chatMessages.length },
  ];

  return (
    <div className="view-container">
      <div className="app-shell" data-app="overview">
        <section className="app-hero">
          <div className="app-hero-content">
            <div>
              <h2 className="app-hero-title">System Overview</h2>
              <p className="app-hero-subtitle">
                Real-time control snapshot for your gateway, connected nodes, channels,
                and the currently selected session.
              </p>
              <div className="app-hero-meta">
                <span className="app-badge-dot" />
                <span>{connectionState}</span>
                <span className="app-mono-pill mono">{gatewayUrl}</span>
              </div>
            </div>
            <div className="app-mono-pill mono">{settings.sessionKey}</div>
          </div>
        </section>

        <section className="app-kpis">
          {kpis.map((kpi) => (
            <article className="app-kpi" key={kpi.label}>
              <span className="app-kpi-label">{kpi.label}</span>
              <span className="app-kpi-value">{kpi.value}</span>
            </article>
          ))}
        </section>

        <section className="app-grid">
          <article className="app-panel app-col-7">
            <header className="app-panel-head">
              <h3 className="app-panel-title">Connected Execution Nodes</h3>
              <span className="app-panel-meta">{nodes.length} active</span>
            </header>
            <div className="app-panel-body">
              {nodes.length ? (
                <div className="app-list">
                  {nodes.map((nodeId) => {
                    const nodeToolCount = tools.filter((tool) =>
                      tool.name.startsWith(`${nodeId}__`),
                    ).length;
                    return (
                      <div className="app-list-item" key={nodeId}>
                        <div className="app-list-head">
                          <div>
                            <div className="app-list-title mono">{nodeId}</div>
                            <div className="app-list-subtitle">
                              Execution host currently serving tool requests.
                            </div>
                          </div>
                          <span className="pill pill-success">{nodeToolCount} tools</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="app-empty">
                  <div>
                    <div className="app-empty-icon">🖥️</div>
                    <div>No nodes connected yet.</div>
                  </div>
                </div>
              )}
            </div>
          </article>

          <article className="app-panel app-col-5">
            <header className="app-panel-head">
              <h3 className="app-panel-title">Current Session</h3>
              <span className="app-panel-meta">live context</span>
            </header>
            <div className="app-panel-body">
              <div className="app-list">
                <div className="app-list-item">
                  <div className="app-meta-row">
                    <div className="app-meta-label">Session Key</div>
                    <div className="app-meta-value mono">{settings.sessionKey}</div>
                  </div>
                </div>
                <div className="app-list-item">
                  <div className="app-list-meta">
                    <div className="app-meta-row">
                      <div className="app-meta-label">Message Count</div>
                      <div className="app-meta-value">{chatMessages.length}</div>
                    </div>
                    <div className="app-meta-row">
                      <div className="app-meta-label">Connection</div>
                      <div className="app-meta-value">{connectionState}</div>
                    </div>
                    <div className="app-meta-row">
                      <div className="app-meta-label">Channel Accounts</div>
                      <div className="app-meta-value">{channels.length}</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </article>
        </section>
      </div>
    </div>
  );
}
