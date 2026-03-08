/**
 * Nodes View
 */

import { html, nothing } from "lit";
import type { GsvApp } from "../app";
import type { ToolDefinition } from "../types";

type NodeInfo = {
  id: string;
  tools: ToolDefinition[];
};

export function renderNodes(app: GsvApp) {
  const nodes = groupToolsByNode(app.tools);
  const nativeTools = app.tools.filter(t => t.name.startsWith("gsv__"));
  
  return html`
    <div class="view-container">
      <div class="section-header">
        <h2 class="section-title">Connected Nodes</h2>
        <button 
          class="btn btn-secondary btn-sm"
          @click=${() => app["loadTools"]()}
          ?disabled=${app.toolsLoading}
        >
          ${app.toolsLoading ? html`<span class="spinner"></span>` : "Refresh"}
        </button>
      </div>
      
      ${app.toolsLoading && app.tools.length === 0 ? html`
        <div class="card">
          <div class="card-body">
            <div class="thinking-indicator">
              <span class="spinner"></span>
              <span>Loading nodes...</span>
            </div>
          </div>
        </div>
      ` : nodes.length === 0 && nativeTools.length === 0 ? html`
        <div class="empty-state">
          <div class="empty-state-icon">🖥️</div>
          <h3 class="empty-state-title">No nodes connected</h3>
          <p class="empty-state-description">
            Connect a node using: <code>gsv node</code>
          </p>
        </div>
      ` : html`
        <!-- Native Tools -->
        ${nativeTools.length > 0 ? html`
          <div class="card" style="margin-bottom: var(--space-4)">
            <div class="card-header">
              <h3 class="card-title">
                <span style="margin-right: var(--space-2)">🚀</span>
                Native Tools (Gateway)
              </h3>
              <span class="pill">${nativeTools.length} tools</span>
            </div>
            <div class="card-body">
              ${renderToolList(nativeTools, false)}
            </div>
          </div>
        ` : nothing}
        
        <!-- Node Tools -->
        ${nodes.map(node => html`
          <div class="card" style="margin-bottom: var(--space-4)">
            <div class="card-header">
              <h3 class="card-title">
                <span style="margin-right: var(--space-2)">🖥️</span>
                ${node.id}
              </h3>
              <span class="pill pill-success">${node.tools.length} tools</span>
            </div>
            <div class="card-body">
              ${renderToolList(node.tools, true)}
            </div>
          </div>
        `)}
      `}
    </div>
  `;
}

function renderToolList(tools: ToolDefinition[], showShortName: boolean) {
  return html`
    <div style="display: flex; flex-direction: column; gap: var(--space-2)">
      ${tools.map(tool => {
        const displayName = showShortName ? tool.name.split("__")[1] || tool.name : tool.name;
        return html`
          <div style="display: flex; flex-direction: column; padding: var(--space-2); background: var(--bg-tertiary); border-radius: var(--radius-md)">
            <div style="display: flex; align-items: center; gap: var(--space-2)">
              <code style="font-size: var(--font-size-sm); color: var(--accent-primary)">${displayName}</code>
            </div>
            <p style="font-size: var(--font-size-xs); color: var(--text-muted); margin-top: var(--space-1)">
              ${tool.description}
            </p>
          </div>
        `;
      })}
    </div>
  `;
}

function groupToolsByNode(tools: ToolDefinition[]): NodeInfo[] {
  const nodeMap = new Map<string, ToolDefinition[]>();
  
  for (const tool of tools) {
    if (tool.name.startsWith("gsv__")) continue; // Skip native tools
    
    const parts = tool.name.split("__");
    if (parts.length !== 2) continue;
    
    const nodeId = parts[0];
    if (!nodeMap.has(nodeId)) {
      nodeMap.set(nodeId, []);
    }
    nodeMap.get(nodeId)!.push(tool);
  }
  
  return Array.from(nodeMap.entries()).map(([id, tools]) => ({ id, tools }));
}
