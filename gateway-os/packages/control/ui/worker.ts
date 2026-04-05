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

function renderConfigSections(routeBase, entriesByKey) {
  return CONFIG_SECTIONS.map((section) => {
    const fields = section.fields.map((field) => {
      const value = fieldValue(entriesByKey, field);
      return `
        <label class="field-card ${field.kind === "textarea" ? "is-wide" : ""}">
          ${field.kind === "boolean" ? "" : `<span class="field-label">${escapeHtml(field.label)}</span>`}
          <span class="field-description">${escapeHtml(field.description ?? "")}</span>
          ${renderField(field, value)}
        </label>
      `;
    }).join("");

    return `
      <section class="panel">
        <div class="section-header">
          <div>
            <p class="eyebrow">Config</p>
            <h2>${escapeHtml(section.title)}</h2>
            <p class="muted">${escapeHtml(section.description)}</p>
          </div>
        </div>
        <form method="post" action="${escapeHtml(routeBase)}" class="section-form">
          <input type="hidden" name="action" value="save-section" />
          <input type="hidden" name="sectionId" value="${escapeHtml(section.id)}" />
          <div class="field-grid">${fields}</div>
          <div class="section-actions">
            <button type="submit" class="runtime-btn">Save ${escapeHtml(section.title)}</button>
          </div>
        </form>
      </section>
    `;
  }).join("");
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
            <input type="hidden" name="action" value="token-revoke" />
            <input type="hidden" name="tokenId" value="${escapeHtml(token.tokenId)}" />
            <input type="hidden" name="revokeReason" value="${escapeHtml(state.revokeReason)}" />
            <button type="submit" class="runtime-btn danger">Revoke</button>
          </form>
        </article>
      `).join("");

  return `
    <section class="panel">
      <div class="section-header">
        <div>
          <p class="eyebrow">Access</p>
          <h2>Tokens</h2>
          <p class="muted">Create scoped node, service, or user tokens and revoke stale credentials.</p>
        </div>
      </div>
      ${createdToken ? `<article class="notice-card"><p class="eyebrow">New token</p><pre>${escapeHtml(createdToken)}</pre></article>` : ""}
      <form method="post" action="${escapeHtml(routeBase)}" class="section-form">
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
            <input type="hidden" name="action" value="unlink" />
            <input type="hidden" name="linkAdapter" value="${escapeHtml(link.adapter)}" />
            <input type="hidden" name="linkAccountId" value="${escapeHtml(link.accountId)}" />
            <input type="hidden" name="linkActorId" value="${escapeHtml(link.actorId)}" />
            <button type="submit" class="runtime-btn danger">Unlink</button>
          </form>
        </article>
      `).join("");

  return `
    <section class="panel">
      <div class="section-header">
        <div>
          <p class="eyebrow">Access</p>
          <h2>Links</h2>
          <p class="muted">Manage linked channel identities and consume pending link codes.</p>
        </div>
      </div>
      <div class="sub-grid">
        <form method="post" action="${escapeHtml(routeBase)}" class="section-form">
          <input type="hidden" name="action" value="link-code" />
          <label class="field-card is-wide"><span class="field-label">Link Code</span><input type="text" name="linkCode" value="${escapeHtml(state.linkCode)}" placeholder="Paste code from adapter challenge" /></label>
          <div class="section-actions"><button type="submit" class="runtime-btn">Consume code</button></div>
        </form>
        <form method="post" action="${escapeHtml(routeBase)}" class="section-form">
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
    <section class="panel">
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
    <section class="panel">
      <div class="section-header">
        <div>
          <p class="eyebrow">Advanced</p>
          <h2>Raw Config</h2>
          <p class="muted">Direct key/value writes for config entries.</p>
        </div>
      </div>
      <form method="post" action="${escapeHtml(routeBase)}" class="section-form">
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
      :root { color-scheme: dark; }
      body {
        margin: 0;
        font: 14px/1.5 var(--gsv-font-sans, "Inter", sans-serif);
        background: var(--gsv-color-bg, #0c111b);
        color: var(--gsv-color-text, #f3f5f7);
      }
      main {
        box-sizing: border-box;
        min-height: 100vh;
        padding: 24px;
        display: grid;
        gap: 18px;
      }
      .hero,
      .panel {
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(10, 15, 23, 0.72);
        border-radius: 18px;
        box-shadow: 0 14px 38px rgba(0, 0, 0, 0.22);
      }
      .hero { padding: 22px; }
      .panel { padding: 18px; }
      .eyebrow {
        margin: 0 0 8px;
        font-size: 11px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: rgba(193, 205, 224, 0.72);
      }
      h1, h2, h3, p { margin: 0; }
      h1 { font-size: clamp(28px, 5vw, 48px); line-height: 1.05; }
      h2 { font-size: 22px; }
      h3 { font-size: 16px; }
      .muted { color: rgba(193, 205, 224, 0.76); }
      .section-header { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
      .section-form,
      .sub-grid { display: grid; gap: 14px; }
      .field-grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      .field-card {
        display: grid;
        gap: 8px;
        padding: 14px;
        border-radius: 14px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.03);
      }
      .field-card.is-wide { grid-column: 1 / -1; }
      .field-label { font-weight: 600; }
      .field-description { color: rgba(193, 205, 224, 0.7); font-size: 12px; }
      .checkbox-row { display: flex; align-items: center; gap: 10px; font-weight: 600; }
      input, select, textarea {
        width: 100%;
        box-sizing: border-box;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.04);
        color: inherit;
        padding: 10px 12px;
        font: inherit;
      }
      textarea { resize: vertical; }
      .section-actions { display: flex; gap: 10px; flex-wrap: wrap; }
      .runtime-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        text-decoration: none;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.06);
        color: inherit;
        border-radius: 999px;
        padding: 10px 14px;
        font: inherit;
        cursor: pointer;
      }
      .runtime-btn.danger { border-color: rgba(255, 120, 120, 0.26); color: #ffb4b4; }
      .list-grid { display: grid; gap: 12px; }
      .list-row {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        padding: 14px;
        border-radius: 14px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.03);
      }
      .compact-row { align-items: center; }
      .inline-form,
      .stack-gap { display: inline-flex; }
      .notice-card,
      .error-card {
        padding: 14px;
        border-radius: 14px;
        margin-bottom: 14px;
      }
      .notice-card {
        border: 1px solid rgba(120, 207, 255, 0.18);
        background: rgba(120, 207, 255, 0.08);
      }
      .error-card {
        border: 1px solid rgba(255, 120, 120, 0.22);
        background: rgba(255, 120, 120, 0.08);
        color: #ffb4b4;
      }
      pre, code {
        font-family: var(--gsv-font-mono, "SFMono-Regular", "Consolas", monospace);
      }
      pre {
        margin: 10px 0 0;
        white-space: pre-wrap;
        word-break: break-word;
        background: rgba(5, 9, 19, 0.72);
        border-radius: 12px;
        padding: 12px;
      }
      @media (max-width: 760px) {
        main { padding: 14px; }
        .list-row { grid-template-columns: 1fr; display: grid; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <p class="eyebrow">System Control</p>
        <h1>Control</h1>
        <p class="muted">Manage kernel config, access credentials, links, and adapter connections. Theme and shell chrome remain host-owned.</p>
      </section>
      ${payload.notice ? `<section class="notice-card"><p>${escapeHtml(payload.notice)}</p></section>` : ""}
      ${payload.error ? `<section class="error-card"><p>${escapeHtml(payload.error)}</p></section>` : ""}
      ${renderConfigSections(routeBase, entriesByKey)}
      ${renderTokens(routeBase, payload.tokens, payload.state, payload.createdToken)}
      ${renderLinks(routeBase, payload.links, payload.state)}
      ${renderAdapterSection(routeBase, payload.state, payload.adapterStatus, payload.adapterChallenge, payload.adapterError)}
      ${renderAdvanced(routeBase, payload.entries, payload.state)}
    </main>
  </body>
</html>`;
}

async function loadPageData(kernel, state) {
  const [configResult, tokenResult, linkResult, adapterResult] = await Promise.allSettled([
    kernel.request("sys.config.get", {}),
    kernel.request("sys.token.list", {}),
    kernel.request("sys.link.list", {}),
    kernel.request("adapter.status", {
      adapter: state.adapterId,
      accountId: state.adapterAccountId.trim() || undefined,
    }),
  ]);

  return {
    entries: configResult.status === "fulfilled" && Array.isArray(configResult.value?.entries) ? configResult.value.entries : [],
    tokens: tokenResult.status === "fulfilled" && Array.isArray(tokenResult.value?.tokens) ? [...tokenResult.value.tokens].sort((left, right) => Number(right?.createdAt ?? 0) - Number(left?.createdAt ?? 0)) : [],
    links: linkResult.status === "fulfilled" && Array.isArray(linkResult.value?.links) ? [...linkResult.value.links].sort((left, right) => Number(right?.createdAt ?? 0) - Number(left?.createdAt ?? 0)) : [],
    adapterStatus: adapterResult.status === "fulfilled" && Array.isArray(adapterResult.value?.accounts) ? adapterResult.value.accounts : [],
    adapterError: adapterResult.status === "rejected" ? (adapterResult.reason instanceof Error ? adapterResult.reason.message : String(adapterResult.reason)) : "",
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
