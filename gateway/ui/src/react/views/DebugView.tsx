import { FormEvent, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Input, Textarea } from "@cloudflare/kumo/components/input";
import { useReactUiStore } from "../state/store";

type DebugViewProps = {
  embedded?: boolean;
};

export function DebugView({ embedded = false }: DebugViewProps = {}) {
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
    <div className={embedded ? undefined : "view-container"}>
      <div className={embedded ? "app-list" : "app-shell"} data-app={embedded ? undefined : "debug"}>
        {!embedded ? (
          <section className="app-hero">
            <div className="app-hero-content">
              <div>
                <h2 className="app-hero-title">Debug Console</h2>
                <p className="app-hero-subtitle">
                  Send raw RPC calls and inspect live gateway events flowing through
                  this client connection.
                </p>
                <div className="app-hero-meta">
                  <span className="app-badge-dot" />
                  <span>{debugLog.length} event(s) captured</span>
                </div>
              </div>
              <Button size="sm" variant="secondary" onClick={() => clearDebugLog()}>
                Clear Log
              </Button>
            </div>
          </section>
        ) : (
          <div className="app-actions" style={{ justifyContent: "flex-end" }}>
            <Button size="sm" variant="secondary" onClick={() => clearDebugLog()}>
              Clear Log
            </Button>
          </div>
        )}

        <section className="app-grid" style={{ flex: 1, minHeight: 0 }}>
          <article className="app-panel app-col-5">
            <header className="app-panel-head">
              <h3 className="app-panel-title">RPC Tester</h3>
              <span className="app-panel-meta">manual requests</span>
            </header>
            <div className="app-panel-body app-scroll">
              <form onSubmit={onRpcSubmit} className="app-list" style={{ gap: "var(--space-4)" }}>
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
                    rows={4}
                    value={rpcParams}
                    onValueChange={setRpcParams}
                  />
                </div>

                <div className="app-actions">
                  <Button type="submit" variant="primary">
                    Send Request
                  </Button>
                </div>

                <div>
                  <label className="form-label">Result</label>
                  <pre className="app-code-block" style={{ maxHeight: 320 }}>
                    <code>{rpcResult}</code>
                  </pre>
                </div>
              </form>
            </div>
          </article>

          <article className="app-panel app-col-7">
            <header className="app-panel-head">
              <h3 className="app-panel-title">Event Stream</h3>
              <span className="app-panel-meta">newest first</span>
            </header>
            <div className="app-panel-body app-scroll">
              {debugLog.length === 0 ? (
                <div className="app-empty" style={{ minHeight: 220 }}>
                  <div>
                    <div className="app-empty-icon">🧪</div>
                    <div>No events yet</div>
                  </div>
                </div>
              ) : (
                <div className="app-list">
                  {debugLog
                    .slice()
                    .reverse()
                    .map((entry, index) => (
                      <div
                        className="app-list-item"
                        key={`${entry.time.getTime()}-${index}`}
                      >
                        <div className="app-list-head">
                          <div>
                            <div className="app-list-title mono">{entry.type}</div>
                            <div className="app-list-subtitle">
                              {entry.time.toLocaleTimeString()}
                            </div>
                          </div>
                        </div>
                        <pre className="app-code-block" style={{ marginTop: "var(--space-3)" }}>
                          <code>{JSON.stringify(entry.data, null, 2)}</code>
                        </pre>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </article>
        </section>
      </div>
    </div>
  );
}
