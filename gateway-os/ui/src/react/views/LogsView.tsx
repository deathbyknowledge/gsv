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
    return Array.from(ids);
  }, [tools]);

  return (
    <div className="view-container">
      <div className="section-header">
        <span className="section-title">Node Logs</span>
      </div>

      <div className="card" style={{ marginBottom: "var(--space-4)" }}>
        <div
          className="card-body"
          style={{
            display: "flex",
            gap: "var(--space-4)",
            alignItems: "flex-end",
            flexWrap: "wrap",
          }}
        >
          <div className="form-group" style={{ margin: 0, minWidth: 200 }}>
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

          <div className="form-group" style={{ margin: 0, minWidth: 120 }}>
            <Input
              label="Lines"
              type="number"
              className="ui-input-fix"
              size="lg"
              value={logsLines}
              min={1}
              max={5000}
              onChange={(event) => setLogsLines(parseInt(event.target.value || "200", 10))}
              onBlur={(event) =>
                setLogsLines(Math.max(1, Math.min(5000, parseInt(event.target.value || "200", 10))))
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
      </div>

      {logsError ? (
        <div className="connect-error" style={{ marginBottom: "var(--space-4)" }}>
          {logsError}
        </div>
      ) : null}

      {logsData ? (
        <div className="card">
          <div className="card-header">
            <span className="card-title">
              {logsData.nodeId || "All Nodes"} - {logsData.count} line
              {logsData.count !== 1 ? "s" : ""}
              {logsData.truncated ? (
                <span className="pill pill-warning" style={{ marginLeft: "var(--space-2)" }}>
                  Truncated
                </span>
              ) : null}
            </span>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <pre className="logs-output">{logsData.lines.join("\n")}</pre>
          </div>
        </div>
      ) : !logsLoading ? (
        <div className="empty-state">
          <div className="empty-state-icon">📜</div>
          <div className="empty-state-title">No Logs Loaded</div>
          <div className="empty-state-description">
            Select a node and click "Fetch Logs" to view output.
          </div>
        </div>
      ) : null}
    </div>
  );
}
