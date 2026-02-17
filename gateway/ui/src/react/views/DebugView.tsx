import { FormEvent, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { useReactUiStore } from "../state/store";

export function DebugView() {
  const debugLog = useReactUiStore((s) => s.debugLog);
  const clearDebugLog = useReactUiStore((s) => s.clearDebugLog);
  const rpcRequest = useReactUiStore((s) => s.rpcRequest);

  const [rpcMethod, setRpcMethod] = useState("");
  const [rpcParams, setRpcParams] = useState("");
  const [rpcResult, setRpcResult] = useState("— No result yet —");

  const onRpcSubmit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const params = rpcParams.trim() ? JSON.parse(rpcParams) : undefined;
      const result = await rpcRequest(rpcMethod, params);
      setRpcResult(JSON.stringify(result, null, 2));
    } catch (error) {
      setRpcResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="view-container">
      <div className="section-header">
        <h2 className="section-title">Debug</h2>
        <Button size="sm" variant="secondary" onClick={() => clearDebugLog()}>
          Clear Log
        </Button>
      </div>

      <div className="card" style={{ marginBottom: "var(--space-4)" }}>
        <div className="card-header">
          <h3 className="card-title">RPC Tester</h3>
        </div>
        <div className="card-body">
          <form onSubmit={onRpcSubmit}>
            <div className="form-group">
              <Input
                label="Method"
                type="text"
                className="mono ui-input-fix"
                size="lg"
                placeholder="e.g., tools.list"
                value={rpcMethod}
                onChange={(event) => setRpcMethod(event.target.value)}
              />
            </div>

            <div className="form-group">
              <Textarea
                label="Params (JSON)"
                className="mono ui-input-fix"
                size="lg"
                placeholder='{"sessionKey":"..."}'
                rows={3}
                value={rpcParams}
                onValueChange={setRpcParams}
              />
            </div>

            <Button type="submit" variant="primary">
              Send Request
            </Button>

            <div className="form-group" style={{ marginTop: "var(--space-4)" }}>
              <label className="form-label">Result</label>
              <pre
                style={{
                  margin: 0,
                  padding: "var(--space-3)",
                  background: "var(--bg-tertiary)",
                  borderRadius: "var(--radius-md)",
                  fontSize: "var(--font-size-xs)",
                  maxHeight: 300,
                  overflow: "auto",
                }}
              >
                <code>{rpcResult}</code>
              </pre>
            </div>
          </form>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Event Log</h3>
          <span className="pill">{debugLog.length} events</span>
        </div>
        <div className="card-body" style={{ maxHeight: 400, overflowY: "auto" }}>
          {debugLog.length === 0 ? (
            <p className="muted">No events yet</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
              {debugLog
                .slice()
                .reverse()
                .map((entry, index) => (
                  <div
                    key={`${entry.time.getTime()}-${index}`}
                    style={{
                      padding: "var(--space-2)",
                      background: "var(--bg-tertiary)",
                      borderRadius: "var(--radius-md)",
                      fontSize: "var(--font-size-xs)",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--space-1)" }}>
                      <span className="mono" style={{ color: "var(--accent-primary)" }}>
                        {entry.type}
                      </span>
                      <span className="muted">{entry.time.toLocaleTimeString()}</span>
                    </div>
                    <pre style={{ margin: 0, overflowX: "auto" }}>
                      <code>{JSON.stringify(entry.data, null, 2)}</code>
                    </pre>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
