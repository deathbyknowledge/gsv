export async function handleFetch(request, context = {}) {
  const props = context.props ?? {};
  const env = context.env ?? {};

const CONFIG_SECTIONS = [
  {
    id: "ai",
    title: "AI",
    description: "Model provider and behavior used by processes when they run agent loops.",
    fields: [
      { key: "config/ai/provider", label: "Provider", kind: "text", placeholder: "openrouter" },
      { key: "config/ai/model", label: "Model", kind: "text", placeholder: "qwen/qwen3.5-35b-a3b" },
      { key: "config/ai/api_key", label: "API Key", kind: "password" },
      {
        key: "config/ai/reasoning",
        label: "Reasoning",
        kind: "select",
        options: [
          { value: "off", label: "Off" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
      },
      { key: "config/ai/max_tokens", label: "Max Tokens", kind: "number" },
      { key: "config/ai/max_context_bytes", label: "Max Context Bytes", kind: "number" },
      { key: "config/ai/system_prompt", label: "System Prompt", kind: "textarea" },
    ],
  },
  {
    id: "shell",
    title: "Shell",
    description: "Execution limits and command runtime behavior for shell operations.",
    fields: [
      { key: "config/shell/timeout_ms", label: "Timeout (ms)", kind: "number" },
      { key: "config/shell/max_output_bytes", label: "Max Output Bytes", kind: "number" },
      { key: "config/shell/network_enabled", label: "Network Enabled", kind: "boolean" },
    ],
  },
  {
    id: "server",
    title: "Server",
    description: "Server identity and metadata presented to clients.",
    fields: [
      { key: "config/server/name", label: "Server Name", kind: "text", defaultValue: "gsv" },
      { key: "config/server/version", label: "Server Version", kind: "text" },
    ],
  },
  {
    id: "auth",
    title: "Authentication",
    description: "Core auth behavior for machine and user entry points.",
    fields: [
      { key: "config/auth/allow_machine_password", label: "Allow Machine Password", kind: "boolean" },
    ],
  },
];

const CONFIG_SECTION_IDS = new Set(CONFIG_SECTIONS.map((section) => section.id));
const CONTROL_TABS = [
  { id: "config", title: "Config" },
  { id: "access", title: "Access" },
  { id: "advanced", title: "Advanced" },
];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTimestampMs(value) {
  if (value === null || value === undefined) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString();
}

function compactPreview(value, maxLength = 120) {
  const compact = String(value ?? "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength)}...`;
}

function defaultFieldValue(field) {
  if (field.defaultValue !== undefined) {
    return field.defaultValue;
  }
  if (field.kind === "boolean") {
    return "false";
  }
  if (field.kind === "select") {
    return field.options?.[0]?.value ?? "";
  }
  return "";
}

function entryMap(entries) {
  const map = new Map();
  for (const entry of entries) {
    map.set(String(entry?.key ?? ""), String(entry?.value ?? ""));
  }
  return map;
}

function fieldValue(entriesByKey, field) {
  return entriesByKey.has(field.key) ? String(entriesByKey.get(field.key) ?? "") : defaultFieldValue(field);
}

function parseInteger(input) {
  const value = String(input ?? "").trim();
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function parseJsonObject(input) {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Adapter config must be a JSON object.");
  }
  return parsed;
}

function readUiState(url, formData) {
  const read = (key, fallback = "") => {
    if (formData && formData.has(key)) {
      return String(formData.get(key) ?? fallback);
    }
    const fromUrl = url.searchParams.get(key);
    return fromUrl === null ? fallback : fromUrl;
  };

  return {
    activeTab: (() => {
      const value = read("activeTab", "config");
      return CONTROL_TABS.some((tab) => tab.id === value) ? value : "config";
    })(),
    activeView: (() => {
      const value = read("activeView", CONFIG_SECTIONS[0]?.id ?? "ai");
      return CONFIG_SECTION_IDS.has(value) ? value : (CONFIG_SECTIONS[0]?.id ?? "ai");
    })(),
    tokenKind: read("tokenKind", "node"),
    tokenLabel: read("tokenLabel"),
    tokenRole: read("tokenRole"),
    tokenDeviceId: read("tokenDeviceId"),
    tokenExpiresAt: read("tokenExpiresAt"),
    tokenUid: read("tokenUid"),
    revokeReason: read("revokeReason"),
    linkCode: read("linkCode"),
    linkAdapter: read("linkAdapter"),
    linkAccountId: read("linkAccountId"),
    linkActorId: read("linkActorId"),
    linkUid: read("linkUid"),
    adapterId: read("adapterId", "whatsapp"),
    adapterAccountId: read("adapterAccountId", "default"),
    adapterConfigJson: read("adapterConfigJson", "{}"),
    rawKey: read("rawKey"),
    rawValue: read("rawValue"),
  };
}

function renderUiStateFields(state) {
  return `
    <input type="hidden" name="activeTab" value="${escapeHtml(state.activeTab)}" />
    <input type="hidden" name="activeView" value="${escapeHtml(state.activeView)}" />
  `;
}

function hrefWithState(routeBase, state, overrides = {}) {
  const url = new URL(`http://local${routeBase}`);
  const nextState = {
    activeTab: state.activeTab,
    activeView: state.activeView,
    ...overrides,
  };
  for (const [key, value] of Object.entries(nextState)) {
    if (value !== undefined && value !== null && String(value).length > 0) {
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
}

function renderField(field, value) {
  if (field.kind === "textarea") {
    return `<textarea name="${escapeHtml(field.key)}" rows="5" placeholder="${escapeHtml(field.placeholder ?? "")}">${escapeHtml(value)}</textarea>`;
  }
  if (field.kind === "boolean") {
    return `<label class="checkbox-row"><input type="checkbox" name="${escapeHtml(field.key)}" value="true" ${value === "true" ? "checked" : ""} /> <span>${escapeHtml(field.label)}</span></label>`;
  }
  if (field.kind === "select") {
    const options = (field.options ?? []).map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === value ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("");
    return `<select name="${escapeHtml(field.key)}">${options}</select>`;
  }
  const type = field.kind === "password" ? "password" : field.kind === "number" ? "number" : "text";
  return `<input type="${type}" name="${escapeHtml(field.key)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(field.placeholder ?? "")}" />`;
}

function renderConfigNav(routeBase, state) {
  return `
    <nav class="control-subnav" aria-label="Configuration sections">
      ${CONFIG_SECTIONS.map((section) => `
        <a
          class="control-subnav-link ${state.activeView === section.id ? "is-active" : ""}"
          href="${escapeHtml(hrefWithState(routeBase, state, { activeTab: "config", activeView: section.id }))}"
        >
          <span class="control-subnav-title">${escapeHtml(section.title)}</span>
          <span class="control-subnav-copy">${escapeHtml(section.description)}</span>
        </a>
      `).join("")}
    </nav>
  `;
}

function renderConfigSection(routeBase, entriesByKey, state) {
  const section = CONFIG_SECTIONS.find((candidate) => candidate.id === state.activeView) ?? CONFIG_SECTIONS[0];
  const fields = section.fields.map((field) => {
    const value = fieldValue(entriesByKey, field);
    if (field.kind === "boolean") {
      return `
        <div class="field-card field-card-boolean">
          <span class="field-description">${escapeHtml(field.description ?? "")}</span>
          ${renderField(field, value)}
        </div>
      `;
    }
    return `
      <label class="field-card ${field.kind === "textarea" ? "is-wide" : ""}">
        <span class="field-label">${escapeHtml(field.label)}</span>
        <span class="field-description">${escapeHtml(field.description ?? "")}</span>
        ${renderField(field, value)}
      </label>
    `;
  }).join("");

  return `
    <section class="control-section control-detail">
      <div class="section-header">
        <div>
          <p class="eyebrow">Configuration</p>
          <h2>${escapeHtml(section.title)}</h2>
          <p class="muted">${escapeHtml(section.description)}</p>
        </div>
      </div>
      <form method="post" action="${escapeHtml(routeBase)}" class="section-form">
        ${renderUiStateFields(state)}
        <input type="hidden" name="action" value="save-section" />
        <input type="hidden" name="sectionId" value="${escapeHtml(section.id)}" />
        <div class="field-grid">${fields}</div>
        <div class="section-actions">
          <button type="submit" class="runtime-btn">Save ${escapeHtml(section.title)}</button>
        </div>
      </form>
    </section>
  `;
}

function renderTokens(routeBase, tokens, state, createdToken) {
  const rows = tokens.length === 0
    ? '<p class="muted">No access tokens created.</p>'
    : tokens.map((token) => `
        <article class="list-row">
          <div>
            <h3>${escapeHtml(token.label || token.tokenId)}</h3>
            <p class="muted"><code>${escapeHtml(token.tokenPrefix)}</code> · kind ${escapeHtml(token.kind)} · uid ${escapeHtml(token.uid)}</p>
            <p class="muted">role ${escapeHtml(token.allowedRole ?? "—")} · device ${escapeHtml(token.allowedDeviceId ?? "—")}</p>
            <p class="muted">created ${escapeHtml(formatTimestampMs(token.createdAt))} · last used ${escapeHtml(formatTimestampMs(token.lastUsedAt))}</p>
          </div>
          <form method="post" action="${escapeHtml(routeBase)}" class="inline-form stack-gap">
            ${renderUiStateFields(state)}
            <input type="hidden" name="action" value="token-revoke" />
            <input type="hidden" name="tokenId" value="${escapeHtml(token.tokenId)}" />
            <input type="hidden" name="revokeReason" value="${escapeHtml(state.revokeReason)}" />
            <button type="submit" class="runtime-btn danger">Revoke</button>
          </form>
        </article>
      `).join("");

  return `
    <section class="control-section">
      <div class="section-header">
        <div>
          <p class="eyebrow">Access</p>
          <h2>Tokens</h2>
          <p class="muted">Create scoped node, service, or user tokens and revoke stale credentials.</p>
        </div>
      </div>
      ${createdToken ? `<article class="notice-card"><p class="eyebrow">New token</p><pre>${escapeHtml(createdToken)}</pre></article>` : ""}
      <form method="post" action="${escapeHtml(routeBase)}" class="section-form">
        ${renderUiStateFields(state)}
        <input type="hidden" name="action" value="token-create" />
        <div class="field-grid">
          <label class="field-card"><span class="field-label">Kind</span><select name="tokenKind"><option value="node" ${state.tokenKind === "node" ? "selected" : ""}>Node</option><option value="service" ${state.tokenKind === "service" ? "selected" : ""}>Service</option><option value="user" ${state.tokenKind === "user" ? "selected" : ""}>User</option></select></label>
          <label class="field-card"><span class="field-label">Label</span><input type="text" name="tokenLabel" value="${escapeHtml(state.tokenLabel)}" /></label>
          <label class="field-card"><span class="field-label">Allowed Role</span><select name="tokenRole"><option value="">Any</option><option value="driver" ${state.tokenRole === "driver" ? "selected" : ""}>Driver</option><option value="service" ${state.tokenRole === "service" ? "selected" : ""}>Service</option><option value="user" ${state.tokenRole === "user" ? "selected" : ""}>User</option></select></label>
          <label class="field-card"><span class="field-label">Allowed Device</span><input type="text" name="tokenDeviceId" value="${escapeHtml(state.tokenDeviceId)}" /></label>
          <label class="field-card"><span class="field-label">Expires At (ms)</span><input type="number" name="tokenExpiresAt" value="${escapeHtml(state.tokenExpiresAt)}" /></label>
          <label class="field-card"><span class="field-label">UID</span><input type="number" name="tokenUid" value="${escapeHtml(state.tokenUid)}" /></label>
        </div>
        <div class="section-actions"><button type="submit" class="runtime-btn">Create token</button></div>
      </form>
      <label class="field-card compact-field"><span class="field-label">Default revoke reason</span><input type="text" name="revokeReason" value="${escapeHtml(state.revokeReason)}" form="noop" disabled /></label>
      <div class="list-grid">${rows}</div>
    </section>
  `;
}

function renderLinks(routeBase, links, state) {
  const rows = links.length === 0
    ? '<p class="muted">No linked channel identities.</p>'
    : links.map((link) => `
        <article class="list-row">
          <div>
            <h3>${escapeHtml(link.adapter)} · ${escapeHtml(link.accountId)}</h3>
            <p class="muted">actor ${escapeHtml(link.actorId)} · uid ${escapeHtml(link.uid)} · linked ${escapeHtml(formatTimestampMs(link.createdAt))}</p>
          </div>
          <form method="post" action="${escapeHtml(routeBase)}" class="inline-form">
            ${renderUiStateFields(state)}
            <input type="hidden" name="action" value="unlink" />
            <input type="hidden" name="linkAdapter" value="${escapeHtml(link.adapter)}" />
            <input type="hidden" name="linkAccountId" value="${escapeHtml(link.accountId)}" />
            <input type="hidden" name="linkActorId" value="${escapeHtml(link.actorId)}" />
            <button type="submit" class="runtime-btn danger">Unlink</button>
          </form>
        </article>
      `).join("");

  return `
    <section class="control-section">
      <div class="section-header">
        <div>
          <p class="eyebrow">Access</p>
          <h2>Links</h2>
          <p class="muted">Manage linked channel identities and consume pending link codes.</p>
        </div>
      </div>
      <div class="sub-grid">
        <form method="post" action="${escapeHtml(routeBase)}" class="section-form">
          ${renderUiStateFields(state)}
          <input type="hidden" name="action" value="link-code" />
          <label class="field-card is-wide"><span class="field-label">Link Code</span><input type="text" name="linkCode" value="${escapeHtml(state.linkCode)}" placeholder="Paste code from adapter challenge" /></label>
          <div class="section-actions"><button type="submit" class="runtime-btn">Consume code</button></div>
        </form>
        <form method="post" action="${escapeHtml(routeBase)}" class="section-form">
          ${renderUiStateFields(state)}
          <input type="hidden" name="action" value="link-manual" />
          <div class="field-grid">
            <label class="field-card"><span class="field-label">Adapter</span><input type="text" name="linkAdapter" value="${escapeHtml(state.linkAdapter)}" /></label>
            <label class="field-card"><span class="field-label">Account ID</span><input type="text" name="linkAccountId" value="${escapeHtml(state.linkAccountId)}" /></label>
            <label class="field-card"><span class="field-label">Actor ID</span><input type="text" name="linkActorId" value="${escapeHtml(state.linkActorId)}" /></label>
            <label class="field-card"><span class="field-label">UID</span><input type="number" name="linkUid" value="${escapeHtml(state.linkUid)}" /></label>
          </div>
          <div class="section-actions"><button type="submit" class="runtime-btn">Link identity</button></div>
        </form>
      </div>
      <div class="list-grid">${rows}</div>
    </section>
  `;
}

function renderAdapterSection(routeBase, state, adapterStatus, adapterChallenge, adapterError) {
  const rows = adapterStatus.length === 0
    ? '<p class="muted">No adapter accounts returned for this selector.</p>'
    : adapterStatus.map((account) => `
        <article class="list-row">
          <div>
            <h3>${escapeHtml(account.accountId)}</h3>
            <p class="muted">connected ${escapeHtml(account.connected)} · authenticated ${escapeHtml(account.authenticated)} · mode ${escapeHtml(account.mode ?? "—")}</p>
            <p class="muted">last activity ${escapeHtml(formatTimestampMs(account.lastActivity))} · error ${escapeHtml(account.error ?? "—")}</p>
            ${account.extra ? `<pre>${escapeHtml(JSON.stringify(account.extra, null, 2))}</pre>` : ""}
          </div>
        </article>
      `).join("");

  return `
    <section class="control-section">
      <div class="section-header">
        <div>
          <p class="eyebrow">Adapters</p>
          <h2>Connections</h2>
          <p class="muted">Connect adapters, inspect account status, and disconnect accounts.</p>
        </div>
      </div>
      ${adapterChallenge ? `<article class="notice-card"><p class="eyebrow">Challenge</p><pre>${escapeHtml(JSON.stringify(adapterChallenge, null, 2))}</pre></article>` : ""}
      ${adapterError ? `<article class="error-card"><p>${escapeHtml(adapterError)}</p></article>` : ""}
      <form method="post" action="${escapeHtml(routeBase)}" class="section-form">
        ${renderUiStateFields(state)}
        <div class="field-grid">
          <label class="field-card"><span class="field-label">Adapter</span><input type="text" name="adapterId" value="${escapeHtml(state.adapterId)}" /></label>
          <label class="field-card"><span class="field-label">Account ID</span><input type="text" name="adapterAccountId" value="${escapeHtml(state.adapterAccountId)}" /></label>
          <label class="field-card is-wide"><span class="field-label">Config JSON</span><textarea name="adapterConfigJson" rows="6">${escapeHtml(state.adapterConfigJson)}</textarea></label>
        </div>
        <div class="section-actions">
          <button type="submit" name="action" value="adapter-connect" class="runtime-btn">Connect</button>
          <button type="submit" name="action" value="adapter-disconnect" class="runtime-btn danger">Disconnect</button>
          <button type="submit" name="action" value="adapter-status" class="runtime-btn">Refresh status</button>
        </div>
      </form>
      <div class="list-grid">${rows}</div>
    </section>
  `;
}

function renderAdvanced(routeBase, entries, state) {
  const rows = entries.map((entry) => `
    <article class="list-row compact-row">
      <div>
        <h3><code>${escapeHtml(entry.key)}</code></h3>
        <p class="muted">${escapeHtml(compactPreview(entry.value))}</p>
      </div>
    </article>
  `).join("");

  return `
    <section class="control-section">
      <div class="section-header">
        <div>
          <p class="eyebrow">Advanced</p>
          <h2>Raw Config</h2>
          <p class="muted">Direct key/value writes for config entries.</p>
        </div>
      </div>
      <form method="post" action="${escapeHtml(routeBase)}" class="section-form">
        ${renderUiStateFields(state)}
        <input type="hidden" name="action" value="raw-save" />
        <div class="field-grid">
          <label class="field-card"><span class="field-label">Key</span><input type="text" name="rawKey" value="${escapeHtml(state.rawKey)}" placeholder="config/..." /></label>
          <label class="field-card is-wide"><span class="field-label">Value</span><textarea name="rawValue" rows="4">${escapeHtml(state.rawValue)}</textarea></label>
        </div>
        <div class="section-actions"><button type="submit" class="runtime-btn">Save raw entry</button></div>
      </form>
      <div class="list-grid">${rows || '<p class="muted">No config entries stored.</p>'}</div>
    </section>
  `;
}

function renderTopTabs(routeBase, state) {
  return `
    <nav class="control-tabs" aria-label="Control sections">
      ${CONTROL_TABS.map((tab) => `
        <a
          class="control-tab ${state.activeTab === tab.id ? "is-active" : ""}"
          href="${escapeHtml(hrefWithState(routeBase, state, { activeTab: tab.id }))}"
        >
          ${escapeHtml(tab.title)}
        </a>
      `).join("")}
    </nav>
  `;
}

function renderAccessPanel(routeBase, payload) {
  return `
    <section class="control-workspace control-workspace-stack">
      <section class="control-stack">
        ${renderTokens(routeBase, payload.tokens, payload.state, payload.createdToken)}
        ${renderLinks(routeBase, payload.links, payload.state)}
      </section>
    </section>
  `;
}

function renderActivePanel(routeBase, payload, entriesByKey) {
  if (payload.state.activeTab === "config") {
    return `
      <section class="control-workspace control-workspace-config">
        <section class="control-layout">
          ${renderConfigNav(routeBase, payload.state)}
          ${renderConfigSection(routeBase, entriesByKey, payload.state)}
        </section>
      </section>
    `;
  }
  if (payload.state.activeTab === "access") {
    return renderAccessPanel(routeBase, payload);
  }
  if (payload.state.activeTab === "adapters") {
    return `
      <section class="control-workspace control-workspace-stack">
        ${renderAdapterSection(routeBase, payload.state, payload.adapterStatus, payload.adapterChallenge, payload.adapterError)}
      </section>
    `;
  }
  return `
    <section class="control-workspace control-workspace-stack">
      ${renderAdvanced(routeBase, payload.entries, payload.state)}
    </section>
  `;
}

function renderPage(routeBase, payload) {
  const entriesByKey = entryMap(payload.entries);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Control</title>
    <link rel="stylesheet" href="/runtime/theme.css" />
    <style>
      :root {
        color-scheme: light;
        --page: #e9edf2;
        --surface: rgba(249, 251, 253, 0.96);
        --surface-soft: rgba(243, 247, 251, 0.98);
        --surface-muted: rgba(231, 237, 244, 0.92);
        --text: #191c1e;
        --text-muted: rgba(25, 28, 30, 0.64);
        --text-soft: rgba(25, 28, 30, 0.48);
        --primary: #003466;
        --primary-soft: #1a4b84;
        --accent: #4d6388;
        --accent-soft: rgba(226, 233, 245, 0.96);
        --danger: #8a3b3b;
        --danger-soft: rgba(255, 232, 230, 0.95);
        --notice-soft: rgba(232, 239, 246, 0.95);
        --line: rgba(25, 28, 30, 0.1);
        --shadow: 0 12px 24px rgba(25, 28, 30, 0.04), 0 4px 10px rgba(25, 28, 30, 0.03);
        --display: "Space Grotesk", "Avenir Next", sans-serif;
        --ui: "Manrope", "Segoe UI", sans-serif;
        --mono: "IBM Plex Mono", "SFMono-Regular", monospace;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font: 14px/1.55 var(--ui);
        color: var(--text);
        background:
          radial-gradient(circle at 12% 0%, rgba(255, 255, 255, 0.72) 0%, rgba(255, 255, 255, 0) 28%),
          linear-gradient(180deg, #f6f8fb 0%, var(--page) 100%);
      }
      main {
        min-height: 100vh;
        padding: 0;
        display: grid;
        gap: 0;
      }
      .control-frame {
        display: grid;
        gap: 0;
        align-content: start;
        min-height: 100vh;
        grid-template-rows: auto auto auto 1fr;
      }
      .eyebrow {
        margin: 0 0 6px;
        color: var(--text-soft);
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      h1, h2, h3, p { margin: 0; }
      h1, h2 { font-family: var(--display); letter-spacing: -0.04em; }
      h1 { font-size: clamp(2rem, 4vw, 3.2rem); line-height: 0.94; }
      h2 { font-size: 1.8rem; line-height: 0.96; }
      h3 { font-size: 0.98rem; }
      .muted { color: var(--text-muted); }
      .control-tabs {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        align-items: stretch;
        border-bottom: 1px solid var(--line);
        background: rgba(248, 250, 253, 0.78);
      }
      .control-tab {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 42px;
        padding: 10px 12px;
        text-decoration: none;
        color: var(--text-muted);
        background: transparent;
        border-bottom: 2px solid transparent;
        font-weight: 700;
      }
      .control-tab.is-active {
        color: var(--primary);
        background: rgba(255, 255, 255, 0.42);
        border-bottom-color: var(--primary);
      }
      .control-workspace {
        min-height: 0;
        overflow: hidden;
      }
      .control-workspace-config {
        display: grid;
      }
      .control-workspace-stack {
        padding: 18px 20px;
        align-content: start;
      }
      .control-layout,
      .control-workspace-stack {
        min-height: 100%;
      }
      .control-layout {
        display: grid;
        grid-template-columns: 240px minmax(0, 1fr);
        align-items: stretch;
        min-height: 0;
      }
      .control-subnav {
        display: grid;
        gap: 2px;
        align-content: start;
        padding: 16px 12px;
        border-right: 1px solid var(--line);
        background: rgba(243, 247, 251, 0.54);
      }
      .control-subnav-link {
        display: grid;
        gap: 3px;
        padding: 10px 12px;
        border-radius: 8px;
        text-decoration: none;
        color: inherit;
      }
      .control-subnav-link.is-active {
        background: rgba(222, 231, 245, 0.82);
      }
      .control-detail {
        min-width: 0;
        padding: 18px 20px 22px;
      }
      .control-stack {
        display: grid;
        gap: 0;
        min-height: 0;
      }
      .control-subnav-title {
        font-weight: 700;
      }
      .control-subnav-copy {
        color: var(--text-muted);
        font-size: 12px;
        line-height: 1.45;
      }
      .control-section {
        min-width: 0;
      }
      .control-stack > .control-section + .control-section {
        margin-top: 18px;
        padding-top: 18px;
        border-top: 1px solid var(--line);
      }
      .section-header { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 12px; align-items: start; }
      .section-form,
      .sub-grid { display: grid; gap: 14px; }
      .field-grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      .field-card {
        display: grid;
        gap: 6px;
        padding: 0;
        background: transparent;
      }
      .field-card-boolean {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
      }
      .field-card.is-wide { grid-column: 1 / -1; }
      .field-label {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.02em;
      }
      .field-description { color: var(--text-muted); font-size: 12px; }
      .checkbox-row {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        font-weight: 600;
        justify-self: start;
        white-space: nowrap;
      }
      .checkbox-row input {
        width: 16px;
        height: 16px;
        margin: 0;
      }
      input, select, textarea {
        width: 100%;
        border-radius: 8px;
        border: 1px solid rgba(25, 28, 30, 0.08);
        background: rgba(255, 255, 255, 0.78);
        color: var(--text);
        padding: 9px 11px;
        font: inherit;
        outline: none;
        box-shadow: none;
      }
      input:focus, select:focus, textarea:focus {
        border-color: rgba(0, 52, 102, 0.42);
        background: rgba(255, 255, 255, 0.96);
      }
      textarea { resize: vertical; }
      .section-actions { display: flex; gap: 10px; flex-wrap: wrap; }
      .runtime-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        text-decoration: none;
        border: 1px solid rgba(25, 28, 30, 0.08);
        background: rgba(244, 248, 252, 0.95);
        color: var(--text);
        border-radius: 9px;
        padding: 9px 13px;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }
      .runtime-btn.danger {
        background: rgba(255, 238, 236, 0.92);
        color: var(--danger);
        border-color: rgba(138, 59, 59, 0.12);
      }
      .list-grid {
        display: grid;
        gap: 0;
      }
      .list-row {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        padding: 12px 0;
        border-top: 1px solid var(--line);
      }
      .compact-row { align-items: center; }
      .inline-form,
      .stack-gap { display: inline-flex; }
      .inline-form { align-self: start; }
      .notice-card,
      .error-card {
        padding: 10px 12px;
        border-radius: 12px;
      }
      .notice-card { background: var(--notice-soft); }
      .error-card { background: var(--danger-soft); color: var(--danger); }
      pre, code { font-family: var(--mono); }
      pre {
        margin: 10px 0 0;
        white-space: pre-wrap;
        word-break: break-word;
        background: rgba(236, 241, 247, 0.92);
        border-radius: 10px;
        padding: 10px 12px;
      }
      @media (max-width: 900px) {
        .control-tabs {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .control-layout { grid-template-columns: 1fr; }
        .control-subnav {
          border-right: 0;
          border-bottom: 1px solid var(--line);
        }
        .field-card-boolean {
          align-items: flex-start;
          flex-direction: column;
        }
      }
      @media (max-width: 760px) {
        main { padding: 14px; }
        .list-row { grid-template-columns: 1fr; display: grid; }
        .control-workspace-stack,
        .control-detail {
          padding: 16px;
        }
        .control-tabs {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="control-frame">
        ${renderTopTabs(routeBase, payload.state)}
        ${payload.notice ? `<section class="notice-card"><p>${escapeHtml(payload.notice)}</p></section>` : ""}
        ${payload.error ? `<section class="error-card"><p>${escapeHtml(payload.error)}</p></section>` : ""}
        ${renderActivePanel(routeBase, payload, entriesByKey)}
      </section>
    </main>
  </body>
</html>`;
}

async function loadPageData(kernel, state) {
  const [configResult, tokenResult, linkResult] = await Promise.allSettled([
    kernel.request("sys.config.get", {}),
    kernel.request("sys.token.list", {}),
    kernel.request("sys.link.list", {}),
  ]);

  return {
    entries: configResult.status === "fulfilled" && Array.isArray(configResult.value?.entries) ? configResult.value.entries : [],
    tokens: tokenResult.status === "fulfilled" && Array.isArray(tokenResult.value?.tokens) ? [...tokenResult.value.tokens].sort((left, right) => Number(right?.createdAt ?? 0) - Number(left?.createdAt ?? 0)) : [],
    links: linkResult.status === "fulfilled" && Array.isArray(linkResult.value?.links) ? [...linkResult.value.links].sort((left, right) => Number(right?.createdAt ?? 0) - Number(left?.createdAt ?? 0)) : [],
    adapterStatus: [],
    adapterError: "",
    loadError: [configResult, tokenResult, linkResult]
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason))
      .join("; "),
  };
}

 
    const url = new URL(request.url);
    const routeBase = props.appFrame?.routeBase ?? env.PACKAGE_ROUTE_BASE ?? "/apps/control";
    const kernel = props.kernel;
    if (!kernel) {
      return new Response("KERNEL binding is required", { status: 500 });
    }
    if (url.pathname !== routeBase && url.pathname !== `${routeBase}/`) {
      return new Response("Not Found", { status: 404 });
    }
    if (request.method !== "GET" && request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let notice = "";
    let error = "";
    let createdToken = "";
    let adapterChallenge = null;
    let formData = null;

    if (request.method === "POST") {
      formData = await request.formData();
      const action = String(formData.get("action") ?? "").trim();
      try {
        if (action === "save-section") {
          const sectionId = String(formData.get("sectionId") ?? "").trim();
          const section = CONFIG_SECTIONS.find((candidate) => candidate.id === sectionId);
          if (!section) {
            throw new Error("Unknown config section.");
          }
          for (const field of section.fields) {
            const value = field.kind === "boolean"
              ? (formData.has(field.key) ? "true" : "false")
              : String(formData.get(field.key) ?? "");
            await kernel.request("sys.config.set", { key: field.key, value });
          }
          notice = `${section.title} settings saved.`;
        } else if (action === "raw-save") {
          const key = String(formData.get("rawKey") ?? "").trim();
          const value = String(formData.get("rawValue") ?? "");
          if (!key) {
            throw new Error("Config key is required.");
          }
          await kernel.request("sys.config.set", { key, value });
          notice = `Saved ${key}.`;
        } else if (action === "token-create") {
          const args = {
            kind: String(formData.get("tokenKind") ?? "node"),
          };
          const label = String(formData.get("tokenLabel") ?? "").trim();
          const role = String(formData.get("tokenRole") ?? "").trim();
          const allowedDeviceId = String(formData.get("tokenDeviceId") ?? "").trim();
          const uid = parseInteger(formData.get("tokenUid"));
          const expiresAt = parseInteger(formData.get("tokenExpiresAt"));
          if (label) args.label = label;
          if (role) args.allowedRole = role;
          if (allowedDeviceId) args.allowedDeviceId = allowedDeviceId;
          if (uid !== null) {
            if (Number.isNaN(uid)) {
              throw new Error("UID must be a number.");
            }
            args.uid = uid;
          }
          if (expiresAt !== null) {
            if (Number.isNaN(expiresAt)) {
              throw new Error("Expires At must be a number.");
            }
            args.expiresAt = expiresAt;
          }
          const result = await kernel.request("sys.token.create", args);
          createdToken = String(result?.token?.token ?? "");
          notice = `Created ${args.kind} token.`;
        } else if (action === "token-revoke") {
          const tokenId = String(formData.get("tokenId") ?? "").trim();
          const reason = String(formData.get("revokeReason") ?? "").trim();
          if (!tokenId) {
            throw new Error("Token id is required.");
          }
          await kernel.request("sys.token.revoke", { tokenId, reason: reason || undefined });
          notice = `Revoked token ${tokenId}.`;
        } else if (action === "link-code") {
          const code = String(formData.get("linkCode") ?? "").trim();
          if (!code) {
            throw new Error("Link code is required.");
          }
          const result = await kernel.request("sys.link.consume", { code });
          notice = result?.linked ? "Link code consumed." : "No link was created.";
        } else if (action === "link-manual") {
          const adapter = String(formData.get("linkAdapter") ?? "").trim();
          const accountId = String(formData.get("linkAccountId") ?? "").trim();
          const actorId = String(formData.get("linkActorId") ?? "").trim();
          const uid = parseInteger(formData.get("linkUid"));
          if (!adapter || !accountId || !actorId) {
            throw new Error("Adapter, account id, and actor id are required.");
          }
          if (uid !== null && Number.isNaN(uid)) {
            throw new Error("Link UID must be a number.");
          }
          await kernel.request("sys.link", { adapter, accountId, actorId, uid: uid === null ? undefined : uid });
          notice = `Linked ${adapter}/${accountId}.`;
        } else if (action === "unlink") {
          const adapter = String(formData.get("linkAdapter") ?? "").trim();
          const accountId = String(formData.get("linkAccountId") ?? "").trim();
          const actorId = String(formData.get("linkActorId") ?? "").trim();
          if (!adapter || !accountId || !actorId) {
            throw new Error("Adapter, account id, and actor id are required to unlink.");
          }
          await kernel.request("sys.unlink", { adapter, accountId, actorId });
          notice = `Unlinked ${adapter}/${accountId}.`;
        } else if (action === "adapter-connect") {
          const adapter = String(formData.get("adapterId") ?? "").trim();
          const accountId = String(formData.get("adapterAccountId") ?? "").trim();
          const config = parseJsonObject(formData.get("adapterConfigJson"));
          if (!adapter || !accountId) {
            throw new Error("Adapter and account id are required.");
          }
          const result = await kernel.request("adapter.connect", { adapter, accountId, config });
          adapterChallenge = result?.challenge ?? null;
          if (result?.ok === false) {
            throw new Error(String(result.error ?? "Adapter connection failed."));
          }
          notice = result?.message ? String(result.message) : `Connected ${adapter}/${accountId}.`;
        } else if (action === "adapter-disconnect") {
          const adapter = String(formData.get("adapterId") ?? "").trim();
          const accountId = String(formData.get("adapterAccountId") ?? "").trim();
          if (!adapter || !accountId) {
            throw new Error("Adapter and account id are required.");
          }
          const result = await kernel.request("adapter.disconnect", { adapter, accountId });
          if (result?.ok === false) {
            throw new Error(String(result.error ?? "Adapter disconnect failed."));
          }
          notice = result?.message ? String(result.message) : `Disconnected ${adapter}/${accountId}.`;
        } else if (action === "adapter-status" || !action) {
          notice = "Adapter status refreshed.";
        } else {
          throw new Error("Unknown action.");
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    }

    const state = readUiState(url, formData);
    const data = await loadPageData(kernel, state);
    const html = renderPage(routeBase, {
      entries: data.entries,
      tokens: data.tokens,
      links: data.links,
      adapterStatus: data.adapterStatus,
      adapterError: data.adapterError,
      adapterChallenge,
      createdToken,
      state,
      notice,
      error: error || data.loadError,
    });

    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
}

export default { fetch: handleFetch };
