import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import type { CanvasDescriptor, CanvasDocument } from "../../ui/types";
import { useReactUiStore } from "../state/store";

type RpcResponse<T = unknown> = {
  ok: boolean;
  payload?: T;
  error?: { message?: string };
};

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function asActions(spec: Record<string, unknown> | undefined): string[] {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return [];
  }
  const actions = (spec as Record<string, unknown>).actions;
  if (!actions || typeof actions !== "object" || Array.isArray(actions)) {
    return [];
  }
  return Object.keys(actions as Record<string, unknown>).sort();
}

export function CanvasView() {
  const rpcRequest = useReactUiStore((s) => s.rpcRequest);
  const connectionState = useReactUiStore((s) => s.connectionState);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canvases, setCanvases] = useState<CanvasDescriptor[]>([]);
  const [selected, setSelected] = useState<CanvasDocument | null>(null);

  const selectedActionIds = useMemo(
    () => asActions(selected?.spec),
    [selected?.spec],
  );

  const loadCanvases = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = (await rpcRequest("canvas.list", {
        limit: 200,
        offset: 0,
      })) as RpcResponse<{ canvases: CanvasDescriptor[] }>;
      if (!response.ok) {
        throw new Error(response.error?.message || "Failed to load canvases");
      }
      setCanvases(response.payload?.canvases || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [rpcRequest]);

  const loadCanvas = useCallback(
    async (canvasId: string) => {
      setBusy(true);
      setError(null);
      try {
        const response = (await rpcRequest("canvas.get", {
          canvasId,
        })) as RpcResponse<CanvasDocument>;
        if (!response.ok || !response.payload) {
          throw new Error(response.error?.message || "Failed to load canvas");
        }
        setSelected(response.payload);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [rpcRequest],
  );

  const createCanvas = useCallback(async () => {
    const title = prompt("Canvas title");
    if (!title || !title.trim()) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = (await rpcRequest("canvas.create", {
        title: title.trim(),
        mode: "html",
      })) as RpcResponse<CanvasDocument>;
      if (!response.ok || !response.payload) {
        throw new Error(response.error?.message || "Failed to create canvas");
      }
      await loadCanvases();
      setSelected(response.payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [loadCanvases, rpcRequest]);

  const openCanvasView = useCallback(
    async (canvasId: string) => {
      setBusy(true);
      setError(null);
      try {
        const response = (await rpcRequest("canvas.open", {
          canvasId,
        })) as RpcResponse<{ viewId?: string }>;
        if (!response.ok) {
          throw new Error(response.error?.message || "Failed to open canvas view");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [rpcRequest],
  );

  const runAction = useCallback(
    async (actionId: string) => {
      if (!selected) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const response = (await rpcRequest("canvas.action", {
          canvasId: selected.descriptor.canvasId,
          actionId,
        })) as RpcResponse;
        if (!response.ok) {
          throw new Error(response.error?.message || "Failed to run action");
        }
        await loadCanvas(selected.descriptor.canvasId);
        await loadCanvases();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [loadCanvas, loadCanvases, rpcRequest, selected],
  );

  useEffect(() => {
    if (connectionState === "connected") {
      void loadCanvases();
    }
  }, [connectionState, loadCanvases]);

  return (
    <div className="view-container">
      <div className="section-header">
        <h2 className="section-title">Canvases</h2>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button
            size="sm"
            variant="secondary"
            loading={loading}
            onClick={() => {
              void loadCanvases();
            }}
          >
            Refresh
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            onClick={() => {
              void createCanvas();
            }}
          >
            Create
          </Button>
        </div>
      </div>

      {error ? (
        <div className="card">
          <div className="card-body">
            <span className="pill pill-danger">{error}</span>
          </div>
        </div>
      ) : null}

      <div className="workspace-layout">
        <div className="card workspace-panel">
          <div className="card-header">
            <h3 className="card-title">List</h3>
          </div>
          <div className="card-body workspace-panel-body">
            {canvases.length === 0 ? (
              <p className="muted">
                {loading ? "Loading..." : "No canvases yet"}
              </p>
            ) : (
              canvases.map((canvas) => (
                <div
                  key={canvas.canvasId}
                  style={{
                    padding: "var(--space-2)",
                    borderBottom: "1px solid var(--border-muted)",
                    marginBottom: "var(--space-2)",
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{canvas.title}</div>
                  <div className="muted" style={{ fontSize: "var(--font-size-xs)" }}>
                    <code>{canvas.canvasId}</code> · {canvas.mode} · rev{" "}
                    {canvas.revision}
                  </div>
                  <div className="muted" style={{ fontSize: "var(--font-size-xs)" }}>
                    Updated {formatDate(canvas.updatedAt)}
                  </div>
                  <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        void loadCanvas(canvas.canvasId);
                      }}
                    >
                      Inspect
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        void openCanvasView(canvas.canvasId);
                      }}
                    >
                      Open View
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="card workspace-panel">
          <div className="card-header">
            <h3 className="card-title">
              {selected
                ? `${selected.descriptor.title} (${selected.descriptor.canvasId})`
                : "Canvas Document"}
            </h3>
          </div>
          <div className="card-body workspace-panel-body">
            {!selected ? (
              <p className="muted">Select a canvas to inspect spec/state.</p>
            ) : (
              <>
                <div style={{ marginBottom: "var(--space-3)" }}>
                  <div className="muted" style={{ fontSize: "var(--font-size-xs)" }}>
                    revision {selected.descriptor.revision} · mode {selected.descriptor.mode}
                  </div>
                </div>

                {selectedActionIds.length > 0 ? (
                  <div style={{ marginBottom: "var(--space-3)" }}>
                    <div className="muted" style={{ marginBottom: "var(--space-2)" }}>
                      Actions
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
                      {selectedActionIds.map((actionId) => (
                        <Button
                          key={actionId}
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            void runAction(actionId);
                          }}
                        >
                          Run {actionId}
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div>
                  <div className="muted" style={{ marginBottom: "var(--space-2)" }}>
                    State
                  </div>
                  <pre className="tool-result-json">
                    <code>{JSON.stringify(selected.state, null, 2)}</code>
                  </pre>
                </div>

                <div style={{ marginTop: "var(--space-3)" }}>
                  <div className="muted" style={{ marginBottom: "var(--space-2)" }}>
                    Spec
                  </div>
                  <pre className="tool-result-json">
                    <code>{JSON.stringify(selected.spec, null, 2)}</code>
                  </pre>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
