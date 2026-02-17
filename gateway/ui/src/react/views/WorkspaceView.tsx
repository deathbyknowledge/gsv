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
      <div className="section-header">
        <h2 className="section-title">Agent Workspace</h2>
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

      <div className="workspace-layout">
        <div className="card workspace-panel">
          <div className="card-header">
            <h3 className="card-title">Files</h3>
          </div>
          <div className="card-body workspace-panel-body">
            {workspaceLoading && !workspaceFiles ? (
              <div className="thinking-indicator">
                <span className="spinner"></span>
                <span>Loading...</span>
              </div>
            ) : !workspaceFiles ? (
              <p className="muted">Failed to load workspace</p>
            ) : (
              <>
                <div
                  style={{
                    marginBottom: "var(--space-3)",
                    paddingBottom: "var(--space-2)",
                    borderBottom: "1px solid var(--border-muted)",
                  }}
                >
                  <code
                    className="mono"
                    style={{
                      fontSize: "var(--font-size-xs)",
                      color: "var(--text-muted)",
                    }}
                  >
                    {normalizedPath}
                  </code>
                </div>

                {normalizedPath !== "/" ? (
                  <Button
                    variant="ghost"
                    className="nav-item"
                    onClick={() => {
                      void loadWorkspace(getParentPath(normalizedPath));
                    }}
                    style={{
                      padding: "var(--space-2)",
                      margin: "0 calc(var(--space-4) * -1)",
                      justifyContent: "flex-start",
                      width: "calc(100% + var(--space-8))",
                    }}
                  >
                    <span>📁</span>
                    <span>..</span>
                  </Button>
                ) : null}

                {workspaceFiles.directories.map((dir) => (
                  <Button
                    variant="ghost"
                    key={`dir:${dir}`}
                    className="nav-item"
                    onClick={() => {
                      void loadWorkspace(normalizeWorkspacePath(dir));
                    }}
                    style={{
                      padding: "var(--space-2)",
                      margin: "0 calc(var(--space-4) * -1)",
                      justifyContent: "flex-start",
                      width: "calc(100% + var(--space-8))",
                    }}
                  >
                    <span>📁</span>
                    <span>{getEntryLabel(dir)}</span>
                  </Button>
                ))}

                {workspaceFiles.files.map((file) => {
                  const isSelected = workspaceFileContent?.path === file;
                  const icon = file.endsWith(".md") ? "📝" : "📄";
                  return (
                    <Button
                      variant="ghost"
                      key={`file:${file}`}
                      className={`nav-item ${isSelected ? "active" : ""}`}
                      onClick={() => {
                        void readWorkspaceFile(file);
                      }}
                      style={{
                        padding: "var(--space-2)",
                        margin: "0 calc(var(--space-4) * -1)",
                        justifyContent: "flex-start",
                        width: "calc(100% + var(--space-8))",
                      }}
                    >
                      <span>{icon}</span>
                      <span>{getEntryLabel(file)}</span>
                    </Button>
                  );
                })}

                {workspaceFiles.files.length === 0 &&
                workspaceFiles.directories.length === 0 ? (
                  <p className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
                    Empty directory
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>

        <div className="card workspace-panel">
          <div className="card-header">
            <h3 className="card-title">
              {workspaceFileContent ? workspaceFileContent.path : "No file selected"}
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
          </div>
          <div className="card-body workspace-panel-body" style={{ padding: 0 }}>
            {workspaceFileContent ? (
              <textarea
                id="workspace-editor"
                className="workspace-editor"
                value={editorContent}
                onChange={(event) => setEditorContent(event.target.value)}
              />
            ) : (
              <div className="empty-state">
                <div className="empty-state-icon">📝</div>
                <h3 className="empty-state-title">Select a file</h3>
                <p className="empty-state-description">
                  Choose a file from the browser to view and edit.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
