import { useMemo } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { useReactUiStore } from "../state/store";

export function LogsView() {
  const tools = useReactUiStore((s) => s.tools);
  const logsData = useReactUiStore((s) => s.logsData);
  const logsLoading = useReactUiStore((s) => s.logsLoading);
  const logsError = useReactUiStore((s) => s.logsError);
  const logsNodeId = useReactUiStore((s) => s.logsNodeId);
  const logsLines = useReactUiStore((s) => s.logsLines);
  const setLogsNodeId = useReactUiStore((s) => s.setLogsNodeId);
  const setLogsLines = useReactUiStore((s) => s.setLogsLines);
  const loadLogs = useReactUiStore((s) => s.loadLogs);

  const nodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const tool of tools) {
      const sep = tool.name.indexOf("__");
      if (sep > 0) {
        const prefix = tool.name.slice(0, sep);
        if (prefix !== "gsv") {
          ids.add(prefix);
        }
      }
    }
    return Array.from(ids).sort();
  }, [tools]);

  return (
    <div className="view-container">
      <div className="app-shell" data-app="logs">
        <section className="app-hero">
          <div className="app-hero-content">
            <div>
              <h2 className="app-hero-title">Log Monitor</h2>
              <p className="app-hero-subtitle">
                Pull buffered node logs on demand for debugging execution issues and
                runtime behavior.
              </p>
              <div className="app-hero-meta">
                <span className="app-badge-dot" />
                <span>{logsData ? `${logsData.count} line(s) loaded` : "No logs loaded"}</span>
              </div>
            </div>
          </div>
        </section>

        <section className="app-panel">
          <header className="app-panel-head">
            <h3 className="app-panel-title">Filters</h3>
            <span className="app-panel-meta">query controls</span>
          </header>
          <div className="app-panel-body">
            <div className="app-toolbar">
              <div className="form-group" style={{ minWidth: 220 }}>
                <Select<string>
                  label="Node"
                  hideLabel={false}
                  value={logsNodeId}
                  onValueChange={(value) => setLogsNodeId(String(value || ""))}
                >
                  <Select.Option value="">All nodes</Select.Option>
                  {nodeIds.map((id) => (
                    <Select.Option value={id} key={id}>
                      {id}
                    </Select.Option>
                  ))}
                </Select>
              </div>

              <div className="form-group" style={{ minWidth: 140 }}>
                <Input
                  label="Lines"
                  type="number"
                  className="ui-input-fix"
                  size="lg"
                  value={logsLines}
                  min={1}
                  max={5000}
                  onChange={(event) =>
                    setLogsLines(parseInt(event.target.value || "200", 10))
                  }
                  onBlur={(event) =>
                    setLogsLines(
                      Math.max(1, Math.min(5000, parseInt(event.target.value || "200", 10))),
                    )
                  }
                />
              </div>

              <Button
                variant="primary"
                loading={logsLoading}
                onClick={() => {
                  void loadLogs();
                }}
              >
                Fetch Logs
              </Button>
            </div>

            {logsError ? (
              <div className="app-list-item" style={{ marginTop: "var(--space-4)" }}>
                <p className="text-danger">{logsError}</p>
              </div>
            ) : null}
          </div>
        </section>

        <section className="app-panel" style={{ flex: 1, minHeight: 0 }}>
          <header className="app-panel-head">
            <h3 className="app-panel-title">
              {logsData ? logsData.nodeId || "All Nodes" : "Log Output"}
            </h3>
            {logsData ? (
              <div className="app-actions">
                <span className="pill">
                  {logsData.count} line{logsData.count !== 1 ? "s" : ""}
                </span>
                {logsData.truncated ? <span className="pill pill-warning">truncated</span> : null}
              </div>
            ) : null}
          </header>
          <div className="app-panel-body" style={{ padding: "var(--space-3)" }}>
            {logsData ? (
              <pre className="app-code-block" style={{ height: "100%" }}>
                {logsData.lines.join("\n")}
              </pre>
            ) : !logsLoading ? (
              <div className="app-empty" style={{ minHeight: 260 }}>
                <div>
                  <div className="app-empty-icon">📜</div>
                  <div>No logs loaded</div>
                  <div className="text-secondary" style={{ marginTop: "var(--space-1)" }}>
                    Select filters and fetch a new log snapshot.
                  </div>
                </div>
              </div>
            ) : (
              <div className="app-empty" style={{ minHeight: 260 }}>
                <div>
                  <span className="spinner" />
                  <div style={{ marginTop: "var(--space-2)" }}>Fetching logs...</div>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
