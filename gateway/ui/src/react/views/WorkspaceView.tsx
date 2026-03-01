import { useEffect, useMemo, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { useReactUiStore } from "../state/store";

function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  const noLeadingSlash = trimmed.replace(/^\/+/, "");
  const noTrailingSlash = noLeadingSlash.replace(/\/+$/, "");
  return noTrailingSlash || "/";
}

function getEntryLabel(path: string): string {
  const normalizedPath = normalizeWorkspacePath(path);
  if (normalizedPath === "/") {
    return "/";
  }
  const parts = normalizedPath.split("/");
  return parts[parts.length - 1] || normalizedPath;
}

function getParentPath(path: string): string {
  const normalizedPath = normalizeWorkspacePath(path);
  if (normalizedPath === "/") {
    return "/";
  }
  const parts = normalizedPath.split("/");
  if (parts.length <= 1) {
    return "/";
  }
  return parts.slice(0, -1).join("/");
}

export function WorkspaceView() {
  const workspaceFiles = useReactUiStore((s) => s.workspaceFiles);
  const workspaceLoading = useReactUiStore((s) => s.workspaceLoading);
  const workspaceCurrentPath = useReactUiStore((s) => s.workspaceCurrentPath);
  const workspaceFileContent = useReactUiStore((s) => s.workspaceFileContent);
  const loadWorkspace = useReactUiStore((s) => s.loadWorkspace);
  const readWorkspaceFile = useReactUiStore((s) => s.readWorkspaceFile);
  const writeWorkspaceFile = useReactUiStore((s) => s.writeWorkspaceFile);

  const [editorContent, setEditorContent] = useState("");

  useEffect(() => {
    setEditorContent(workspaceFileContent?.content || "");
  }, [workspaceFileContent?.path, workspaceFileContent?.content]);

  const normalizedPath = useMemo(
    () =>
      workspaceFiles?.path ? normalizeWorkspacePath(workspaceFiles.path) : "/",
    [workspaceFiles?.path],
  );

  return (
    <div className="view-container">
      <div className="app-shell" data-app="workspace">
        <section className="app-hero">
          <div className="app-hero-content">
            <div>
              <h2 className="app-hero-title">Workspace Editor</h2>
              <p className="app-hero-subtitle">
                Browse and edit files in the active agent workspace directly from the
                OS shell. Changes write back through gateway RPC.
              </p>
              <div className="app-hero-meta">
                <span className="app-badge-dot" />
                <span className="app-mono-pill mono">{normalizedPath}</span>
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              loading={workspaceLoading}
              onClick={() => {
                void loadWorkspace(workspaceCurrentPath);
              }}
            >
              Refresh
            </Button>
          </div>
        </section>

        <section className="app-split">
          <article className="app-panel">
            <header className="app-panel-head">
              <h3 className="app-panel-title">Explorer</h3>
              <span className="app-panel-meta mono">{normalizedPath}</span>
            </header>
            <div className="app-panel-body app-scroll">
              {workspaceLoading && !workspaceFiles ? (
                <div className="app-empty" style={{ minHeight: 140 }}>
                  <div>
                    <span className="spinner" />
                    <div style={{ marginTop: "var(--space-2)" }}>Loading workspace...</div>
                  </div>
                </div>
              ) : !workspaceFiles ? (
                <div className="app-empty" style={{ minHeight: 140 }}>
                  <div>
                    <div className="app-empty-icon">📂</div>
                    <div>Workspace unavailable</div>
                  </div>
                </div>
              ) : (
                <div className="app-compact-list">
                  {normalizedPath !== "/" ? (
                    <button
                      type="button"
                      className="app-compact-item"
                      onClick={() => {
                        void loadWorkspace(getParentPath(normalizedPath));
                      }}
                    >
                      <span>↩</span>
                      <span>..</span>
                    </button>
                  ) : null}

                  {workspaceFiles.directories.map((dir) => (
                    <button
                      type="button"
                      className="app-compact-item"
                      key={`dir:${dir}`}
                      onClick={() => {
                        void loadWorkspace(normalizeWorkspacePath(dir));
                      }}
                    >
                      <span>📁</span>
                      <span>{getEntryLabel(dir)}</span>
                    </button>
                  ))}

                  {workspaceFiles.files.map((file) => {
                    const isSelected = workspaceFileContent?.path === file;
                    return (
                      <button
                        type="button"
                        className={`app-compact-item ${isSelected ? "active" : ""}`}
                        key={`file:${file}`}
                        onClick={() => {
                          void readWorkspaceFile(file);
                        }}
                      >
                        <span>{file.endsWith(".md") ? "📝" : "📄"}</span>
                        <span>{getEntryLabel(file)}</span>
                      </button>
                    );
                  })}

                  {workspaceFiles.files.length === 0 && workspaceFiles.directories.length === 0 ? (
                    <div className="app-empty" style={{ minHeight: 140 }}>
                      <div>
                        <div className="app-empty-icon">🫥</div>
                        <div>Empty directory</div>
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </article>

          <article className="app-panel">
            <header className="app-panel-head">
              <h3 className="app-panel-title">
                {workspaceFileContent ? getEntryLabel(workspaceFileContent.path) : "Editor"}
              </h3>
              {workspaceFileContent ? (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    void writeWorkspaceFile(workspaceFileContent.path, editorContent);
                  }}
                >
                  Save
                </Button>
              ) : null}
            </header>
            <div className="app-panel-body" style={{ padding: 0 }}>
              {workspaceFileContent ? (
                <textarea
                  id="workspace-editor"
                  className="app-editor"
                  value={editorContent}
                  onChange={(event) => setEditorContent(event.target.value)}
                />
              ) : (
                <div className="app-empty" style={{ minHeight: 320 }}>
                  <div>
                    <div className="app-empty-icon">📝</div>
                    <div>Select a file to begin editing</div>
                    <div className="text-secondary" style={{ marginTop: "var(--space-1)" }}>
                      Changes are written through the workspace RPC interface.
                    </div>
                  </div>
                </div>
              )}
            </div>
          </article>
        </section>
      </div>
    </div>
  );
}
