/**
 * Workspace View
 */

import { html, nothing } from "lit";
import type { GsvApp } from "../app";

export function renderWorkspace(app: GsvApp) {
  return html`
    <div class="view-container">
      <div class="section-header">
        <h2 class="section-title">Agent Workspace</h2>
        <button 
          class="btn btn-secondary btn-sm"
          @click=${() => app.loadWorkspace(app.workspaceCurrentPath)}
          ?disabled=${app.workspaceLoading}
        >
          ${app.workspaceLoading ? html`<span class="spinner"></span>` : "Refresh"}
        </button>
      </div>
      
      <div style="display: grid; grid-template-columns: 300px 1fr; gap: var(--space-4); height: calc(100vh - 200px)">
        <!-- File Browser -->
        <div class="card" style="overflow: hidden; display: flex; flex-direction: column">
          <div class="card-header">
            <h3 class="card-title">Files</h3>
          </div>
          <div class="card-body" style="flex: 1; overflow-y: auto">
            ${renderFileBrowser(app)}
          </div>
        </div>
        
        <!-- File Editor -->
        <div class="card" style="overflow: hidden; display: flex; flex-direction: column">
          <div class="card-header">
            <h3 class="card-title">
              ${app.workspaceFileContent ? app.workspaceFileContent.path : "No file selected"}
            </h3>
            ${app.workspaceFileContent ? html`
              <button 
                class="btn btn-primary btn-sm"
                @click=${() => {
                  const textarea = document.querySelector("#workspace-editor") as HTMLTextAreaElement;
                  if (textarea && app.workspaceFileContent) {
                    app.writeWorkspaceFile(app.workspaceFileContent.path, textarea.value);
                  }
                }}
              >
                Save
              </button>
            ` : nothing}
          </div>
          <div class="card-body" style="flex: 1; overflow: hidden; padding: 0">
            ${app.workspaceFileContent ? html`
              <textarea
                id="workspace-editor"
                style="
                  width: 100%;
                  height: 100%;
                  padding: var(--space-4);
                  font-family: var(--font-mono);
                  font-size: var(--font-size-sm);
                  background: var(--bg-primary);
                  color: var(--text-primary);
                  border: none;
                  resize: none;
                  outline: none;
                "
                .value=${app.workspaceFileContent.content}
              ></textarea>
            ` : html`
              <div class="empty-state">
                <div class="empty-state-icon">📝</div>
                <h3 class="empty-state-title">Select a file</h3>
                <p class="empty-state-description">
                  Choose a file from the browser to view and edit.
                </p>
              </div>
            `}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderFileBrowser(app: GsvApp) {
  if (app.workspaceLoading && !app.workspaceFiles) {
    return html`
      <div class="thinking-indicator">
        <span class="spinner"></span>
        <span>Loading...</span>
      </div>
    `;
  }
  
  if (!app.workspaceFiles) {
    return html`
      <p class="muted">Failed to load workspace</p>
    `;
  }
  
  const { path, files, directories } = app.workspaceFiles;
  
  return html`
    <!-- Current path -->
    <div style="margin-bottom: var(--space-3); padding-bottom: var(--space-2); border-bottom: 1px solid var(--border-muted)">
      <code class="mono" style="font-size: var(--font-size-xs); color: var(--text-muted)">${path}</code>
    </div>
    
    <!-- Parent directory -->
    ${path !== "/" ? html`
      <div 
        class="nav-item"
        @click=${() => {
          const parentPath = path.split("/").slice(0, -1).join("/") || "/";
          app.loadWorkspace(parentPath);
        }}
        style="padding: var(--space-2); margin: 0 calc(var(--space-4) * -1)"
      >
        <span>📁</span>
        <span>..</span>
      </div>
    ` : nothing}
    
    <!-- Directories -->
    ${directories.map(dir => html`
      <div 
        class="nav-item"
        @click=${() => app.loadWorkspace(dir)}
        style="padding: var(--space-2); margin: 0 calc(var(--space-4) * -1)"
      >
        <span>📁</span>
        <span>${dir.split("/").pop()}</span>
      </div>
    `)}
    
    <!-- Files -->
    ${files.map(file => {
      const isSelected = app.workspaceFileContent?.path === file;
      const icon = file.endsWith(".md") ? "📝" : "📄";
      return html`
        <div 
          class="nav-item ${isSelected ? "active" : ""}"
          @click=${() => app.readWorkspaceFile(file)}
          style="padding: var(--space-2); margin: 0 calc(var(--space-4) * -1)"
        >
          <span>${icon}</span>
          <span>${file.split("/").pop()}</span>
        </div>
      `;
    })}
    
    ${files.length === 0 && directories.length === 0 ? html`
      <p class="muted" style="font-size: var(--font-size-sm)">Empty directory</p>
    ` : nothing}
  `;
}
