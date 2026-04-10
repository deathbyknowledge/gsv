const ADAPTERS = [
  {
    id: "whatsapp",
    name: "WhatsApp",
    summary: "Phone-based direct messages and groups.",
    detail: "Pair a phone once, then let the gateway keep the session alive.",
    accountPlaceholder: "primary",
  },
  {
    id: "discord",
    name: "Discord",
    summary: "Bot-driven channels, threads, and communities.",
    detail: "Connect a bot token or rely on the deployment default.",
    accountPlaceholder: "main",
  },
];

const ADAPTER_IDS = new Set(ADAPTERS.map((adapter) => adapter.id));

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTimestampMs(value) {
  if (value === null || value === undefined) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function iconSvg(kind) {
  if (kind === "whatsapp") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6A9.4 9.4 0 0 0 4 16.8L2.7 21.3l4.7-1.2A9.4 9.4 0 1 0 12 2.6m0 1.9a7.5 7.5 0 0 1 6.4 11.4l-.3.5.8 2.8-2.9-.7-.4.2A7.5 7.5 0 1 1 12 4.5m-2.4 3.8c-.2 0-.4 0-.6.5-.2.4-.7 1.3-.7 2.5s.8 2.3.9 2.5c.1.2 1.6 2.7 3.9 3.7 1.9.8 2.3.7 2.7.6.4 0 1.3-.5 1.5-1 .2-.5.2-.9.1-1-.1-.1-.4-.2-.9-.4s-1.3-.6-1.5-.7c-.2-.1-.4-.1-.5.1-.2.2-.6.7-.8.9-.2.2-.3.2-.6.1-.3-.2-1.1-.4-2.1-1.3-.8-.7-1.4-1.7-1.6-2-.2-.3 0-.4.1-.5l.4-.5.2-.4c.1-.2 0-.3 0-.4l-.7-1.7c-.2-.4-.3-.4-.5-.4Z" fill="currentColor"/></svg>`;
  }
  if (kind === "discord") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.7 5.7A15.9 15.9 0 0 0 15.8 4l-.2.4c1.7.4 2.5 1 2.5 1a9.7 9.7 0 0 0-6.1-1.8c-2.1 0-4.1.6-6 1.8 0 0 .8-.6 2.5-1l-.2-.4c-1.4.2-2.8.8-3.9 1.7C1.7 9.4 1 13 1.2 16.6a16.5 16.5 0 0 0 4.8 2.4l1-1.6c-.6-.2-1.2-.5-1.8-.8.2.1.4.2.6.3 1.9.9 3.9 1.3 6.2 1.3 2.3 0 4.3-.4 6.2-1.3l.6-.3c-.6.3-1.2.6-1.8.8l1 1.6a16.6 16.6 0 0 0 4.8-2.4c.3-4.1-.4-7.6-2.8-10.9M9.4 14.5c-.8 0-1.4-.7-1.4-1.6 0-.9.6-1.6 1.4-1.6.8 0 1.4.7 1.4 1.6 0 .9-.6 1.6-1.4 1.6m5.2 0c-.8 0-1.4-.7-1.4-1.6 0-.9.6-1.6 1.4-1.6.8 0 1.4.7 1.4 1.6 0 .9-.6 1.6-1.4 1.6" fill="currentColor"/></svg>`;
  }
  if (kind === "new") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z" fill="currentColor"/></svg>`;
  }
  if (kind === "refresh") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5a7 7 0 0 1 6.1 3.5V6h2v6h-6v-2h3.7A5 5 0 1 0 17 16h2a7 7 0 1 1-7-11Z" fill="currentColor"/></svg>`;
  }
  if (kind === "link") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.6 13.4a1 1 0 0 1 0-1.4l3-3a3 3 0 1 1 4.2 4.2l-2.2 2.2-1.4-1.4 2.2-2.2a1 1 0 0 0-1.4-1.4l-3 3a1 1 0 0 1-1.4 0m2.8-2.8a1 1 0 0 1 0 1.4l-3 3a3 3 0 0 1-4.2-4.2l2.2-2.2 1.4 1.4-2.2 2.2A1 1 0 0 0 9 13.6l3-3a1 1 0 0 1 1.4 0" fill="currentColor"/></svg>`;
  }
  if (kind === "power") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 3h2v10h-2zm1 18a8 8 0 0 1-5.7-13.7l1.4 1.4A6 6 0 1 0 12 6V4a8 8 0 0 1 0 16" fill="currentColor"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>`;
}

function adapterDef(adapterId) {
  return ADAPTERS.find((adapter) => adapter.id === adapterId) ?? ADAPTERS[0];
}

function readState(url, formData) {
  const read = (key, fallback = "") => {
    if (formData && formData.has(key)) {
      return String(formData.get(key) ?? fallback);
    }
    const value = url.searchParams.get(key);
    return value === null ? fallback : value;
  };

  const adapter = read("adapter", "whatsapp");
  const selectedAccount = read("account", "new");
  const whatsappForce = read("whatsappForce") === "true" || read("whatsappForce") === "on";
  return {
    adapter: ADAPTER_IDS.has(adapter) ? adapter : "whatsapp",
    account: selectedAccount || "new",
    whatsappAccountId: read("whatsappAccountId", "primary"),
    whatsappForce,
    discordAccountId: read("discordAccountId", "main"),
  };
}

function stateHref(routeBase, state, overrides = {}) {
  const url = new URL(`http://local${routeBase}`);
  const next = {
    adapter: state.adapter,
    account: state.account,
    whatsappAccountId: state.whatsappAccountId,
    whatsappForce: state.whatsappForce ? "true" : "",
    discordAccountId: state.discordAccountId,
    ...overrides,
  };
  for (const [key, value] of Object.entries(next)) {
    if (value === null || value === undefined || String(value).length === 0) continue;
    url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

function hiddenStateFields(state, overrides = {}) {
  const next = {
    adapter: state.adapter,
    account: state.account,
    whatsappAccountId: state.whatsappAccountId,
    whatsappForce: state.whatsappForce ? "true" : "",
    discordAccountId: state.discordAccountId,
    ...overrides,
  };
  return Object.entries(next)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`)
    .join("");
}

function adapterTone(accounts) {
  const connected = accounts.filter((account) => account.connected).length;
  if (connected > 0) return "is-good";
  if (accounts.length > 0) return "is-warn";
  return "is-idle";
}

function renderAdapterRail(routeBase, state, statusByAdapter) {
  return `
    <aside class="adapters-rail adapters-rail-primary">
      <div class="rail-head">
        <span class="rail-title">Adapters</span>
      </div>
      <nav class="adapter-list" aria-label="Adapters">
        ${ADAPTERS.map((adapter) => {
          const accounts = statusByAdapter[adapter.id] ?? [];
          const tone = adapterTone(accounts);
          return `
            <a class="adapter-row ${state.adapter === adapter.id ? "is-active" : ""}" href="${escapeHtml(stateHref(routeBase, state, { adapter: adapter.id, account: "new" }))}">
              <span class="adapter-row-icon">${iconSvg(adapter.id)}</span>
              <span class="adapter-row-copy">
                <strong>${escapeHtml(adapter.name)}</strong>
                <span>${escapeHtml(adapter.summary)}</span>
              </span>
              <span class="adapter-dot ${tone}"></span>
            </a>
          `;
        }).join("")}
      </nav>
    </aside>
  `;
}

function renderAccountRail(routeBase, state, adapter, accounts) {
  return `
    <aside class="adapters-rail adapters-rail-secondary">
      <div class="rail-head">
        <span class="rail-title">${escapeHtml(adapter.name)}</span>
        <a class="icon-nav ${state.account === "new" ? "is-active" : ""}" href="${escapeHtml(stateHref(routeBase, state, { account: "new" }))}" title="New connection" aria-label="New connection">
          ${iconSvg("new")}
        </a>
      </div>
      <nav class="account-list" aria-label="Accounts">
        <a class="account-row ${state.account === "new" ? "is-active" : ""}" href="${escapeHtml(stateHref(routeBase, state, { account: "new" }))}">
          <span class="account-row-icon">${iconSvg("new")}</span>
          <span class="account-row-copy">
            <strong>New connection</strong>
            <span>${escapeHtml(adapter.detail)}</span>
          </span>
        </a>
        ${accounts.map((account) => {
          const tone = account.connected ? "is-good" : account.authenticated ? "is-warn" : "is-idle";
          return `
            <a class="account-row ${state.account === account.accountId ? "is-active" : ""}" href="${escapeHtml(stateHref(routeBase, state, { account: account.accountId }))}">
              <span class="account-row-icon">${iconSvg(adapter.id)}</span>
              <span class="account-row-copy">
                <strong>${escapeHtml(account.accountId)}</strong>
                <span>${escapeHtml(account.connected ? "Connected" : account.authenticated ? "Authorized" : "Pending")}</span>
              </span>
              <span class="adapter-dot ${tone}"></span>
            </a>
          `;
        }).join("")}
      </nav>
    </aside>
  `;
}

function renderToolbar(state, adapter, selectedAccount) {
  const accountId = selectedAccount?.accountId ?? (adapter.id === "whatsapp" ? state.whatsappAccountId : state.discordAccountId);
  return `
    <header class="detail-toolbar">
      <div class="detail-toolbar-copy">
        <span class="detail-kicker">${escapeHtml(adapter.name)}</span>
        <h1>${escapeHtml(selectedAccount ? selectedAccount.accountId : "New connection")}</h1>
      </div>
      <div class="detail-toolbar-actions">
        <form method="post">
          ${hiddenStateFields(state, { action: "refresh", adapter: adapter.id, account: selectedAccount?.accountId ?? state.account, accountId })}
          <button type="submit" class="icon-button" title="Refresh status" aria-label="Refresh status">${iconSvg("refresh")}</button>
        </form>
        ${selectedAccount ? `
          <form method="post">
            ${hiddenStateFields(state, { action: "disconnect", adapter: adapter.id, account: selectedAccount.accountId, accountId: selectedAccount.accountId })}
            <button type="submit" class="icon-button" title="Disconnect" aria-label="Disconnect">${iconSvg("power")}</button>
          </form>
        ` : ""}
      </div>
    </header>
  `;
}

function renderStatusList(adapter, account) {
  const rows = [
    ["Connection", account.connected ? "Connected" : "Offline"],
    ["Authentication", account.authenticated ? "Authenticated" : "Needs attention"],
    ["Mode", account.mode || "—"],
    ["Last activity", formatTimestampMs(account.lastActivity)],
  ];
  if (adapter.id === "whatsapp") {
    const selfE164 = String(account?.extra?.selfE164 ?? "").trim();
    const selfJid = String(account?.extra?.selfJid ?? "").trim();
    rows.push(["Phone", selfE164 || selfJid || "—"]);
  }
  return `
    <section class="detail-section">
      <div class="section-titlebar">
        <h2>Status</h2>
      </div>
      <dl class="property-list">
        ${rows.map(([label, value]) => `
          <div class="property-row">
            <dt>${escapeHtml(label)}</dt>
            <dd>${escapeHtml(value)}</dd>
          </div>
        `).join("")}
      </dl>
      ${account.error ? `<p class="inline-error">${escapeHtml(account.error)}</p>` : ""}
    </section>
  `;
}

function renderQrChallenge(challenge) {
  if (!challenge || challenge.type !== "qr" || !challenge.data) {
    return "";
  }
  return `
    <section class="detail-section qr-section">
      <div class="section-titlebar">
        <h2>Pair phone</h2>
      </div>
      <div class="qr-layout">
        <img class="qr-image" src="${escapeHtml(challenge.data)}" alt="WhatsApp QR code" />
        <div class="qr-copy">
          <p>${escapeHtml(challenge.message || "Open WhatsApp on your phone and scan this code from Linked Devices.")}</p>
          <ol>
            <li>Open WhatsApp.</li>
            <li>Open Linked Devices.</li>
            <li>Scan this code.</li>
          </ol>
        </div>
      </div>
    </section>
  `;
}

function renderGenericChallenge(challenge) {
  if (!challenge || (challenge.type === "qr" && challenge.data)) {
    return "";
  }
  return `
    <section class="detail-section">
      <div class="section-titlebar">
        <h2>Next step</h2>
      </div>
      <p>${escapeHtml(challenge.message || "Complete the adapter challenge, then refresh status.")}</p>
    </section>
  `;
}

function renderNewConnection(adapter, state, challenge) {
  if (adapter.id === "whatsapp") {
    return `
      <section class="detail-section">
        <div class="section-titlebar">
          <h2>Open pairing flow</h2>
        </div>
        <form method="post" class="editor-form">
          ${hiddenStateFields(state, { action: "connect", adapter: "whatsapp", account: "new" })}
          <label class="field-row">
            <span>Name</span>
            <input type="text" name="whatsappAccountId" value="${escapeHtml(state.whatsappAccountId)}" placeholder="${escapeHtml(adapter.accountPlaceholder)}" spellcheck="false" required />
          </label>
          <label class="toggle-row">
            <input type="checkbox" name="whatsappForce" value="true" ${state.whatsappForce ? "checked" : ""} />
            <span>Force a fresh QR session</span>
          </label>
          <div class="editor-actions">
            <button type="submit" class="icon-button is-primary" title="Open QR flow" aria-label="Open QR flow">${iconSvg("link")}</button>
          </div>
        </form>
      </section>
      ${renderQrChallenge(challenge)}
      ${renderGenericChallenge(challenge)}
    `;
  }

  return `
    <section class="detail-section">
      <div class="section-titlebar">
        <h2>Connect bot</h2>
      </div>
      <form method="post" class="editor-form">
        ${hiddenStateFields(state, { action: "connect", adapter: "discord", account: "new" })}
        <label class="field-row">
          <span>Name</span>
          <input type="text" name="discordAccountId" value="${escapeHtml(state.discordAccountId)}" placeholder="${escapeHtml(adapter.accountPlaceholder)}" spellcheck="false" required />
        </label>
        <label class="field-row">
          <span>Bot token</span>
          <input type="password" name="discordBotToken" value="" placeholder="Leave blank to use the deployment default" />
        </label>
        <p class="hint-copy">Use a dedicated bot account. If the deployment already has a default bot token, you can leave the field empty.</p>
        <div class="editor-actions">
          <button type="submit" class="icon-button is-primary" title="Connect bot" aria-label="Connect bot">${iconSvg("link")}</button>
        </div>
      </form>
    </section>
  `;
}

function renderDetailPane(routeBase, state, adapter, accounts, challenge) {
  const selectedAccount = accounts.find((account) => account.accountId === state.account) ?? null;
  return `
    <section class="detail-pane">
      ${renderToolbar(state, adapter, selectedAccount)}
      <div class="detail-body">
        ${selectedAccount
          ? `${renderStatusList(adapter, selectedAccount)}${renderQrChallenge(challenge)}${renderGenericChallenge(challenge)}`
          : renderNewConnection(adapter, state, challenge)}
      </div>
    </section>
  `;
}

function renderPage(routeBase, state, payload) {
  const adapter = adapterDef(state.adapter);
  const accounts = payload.statusByAdapter[adapter.id] ?? [];
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Adapters</title>
    <link rel="stylesheet" href="/runtime/theme.css" />
    <style>
      :root {
        --panel-1: rgba(7, 19, 26, 0.96);
        --panel-2: rgba(10, 23, 31, 0.95);
        --panel-3: rgba(12, 28, 36, 0.92);
        --surface: rgba(14, 30, 38, 0.82);
        --surface-soft: rgba(255, 255, 255, 0.03);
        --line: rgba(125, 211, 252, 0.12);
        --line-strong: rgba(125, 211, 252, 0.22);
        --good: rgba(138, 224, 255, 0.92);
        --warn: rgba(146, 168, 179, 0.92);
        --idle: rgba(146, 168, 179, 0.55);
        --danger: #ffb6ad;
      }
      html, body { min-height: 100%; }
      body { margin: 0; }
      main {
        min-height: 100vh;
        display: grid;
        grid-template-columns: 250px 280px minmax(0, 1fr);
        background: linear-gradient(180deg, rgba(6, 13, 18, 0.92), rgba(7, 16, 22, 0.98));
      }
      .adapters-rail {
        min-width: 0;
        border-right: 1px solid var(--line);
        background: var(--panel-1);
      }
      .adapters-rail-secondary {
        background: var(--panel-2);
      }
      .rail-head {
        height: 56px;
        padding: 0 16px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid var(--line);
      }
      .rail-title {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: var(--muted);
      }
      .adapter-list,
      .account-list {
        display: flex;
        flex-direction: column;
        padding: 8px;
      }
      .adapter-row,
      .account-row {
        display: grid;
        grid-template-columns: 18px minmax(0, 1fr) 8px;
        gap: 12px;
        align-items: center;
        padding: 12px;
        color: inherit;
        text-decoration: none;
        border-radius: 10px;
      }
      .adapter-row.is-active,
      .account-row.is-active {
        background: rgba(125, 211, 252, 0.08);
      }
      .adapter-row-icon,
      .account-row-icon,
      .icon-button svg,
      .icon-nav svg {
        width: 18px;
        height: 18px;
        display: inline-block;
      }
      .adapter-row-copy,
      .account-row-copy {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .adapter-row-copy strong,
      .account-row-copy strong {
        font-size: 13px;
        font-weight: 600;
      }
      .adapter-row-copy span,
      .account-row-copy span {
        font-size: 12px;
        color: var(--muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .adapter-dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--idle);
      }
      .adapter-dot.is-good { background: var(--good); }
      .adapter-dot.is-warn { background: var(--warn); }
      .adapter-dot.is-idle { background: var(--idle); }
      .icon-nav,
      .icon-button {
        width: 32px;
        height: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid transparent;
        background: transparent;
        color: var(--text);
        border-radius: 8px;
        cursor: pointer;
        text-decoration: none;
      }
      .icon-nav:hover,
      .icon-button:hover,
      .icon-nav.is-active {
        background: rgba(125, 211, 252, 0.08);
        border-color: var(--line-strong);
      }
      .icon-button.is-primary {
        background: rgba(125, 211, 252, 0.1);
        border-color: var(--line-strong);
      }
      .detail-pane {
        min-width: 0;
        display: grid;
        grid-template-rows: 56px minmax(0, 1fr);
        background: var(--panel-3);
      }
      .detail-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 0 18px;
        border-bottom: 1px solid var(--line);
      }
      .detail-toolbar-copy {
        min-width: 0;
      }
      .detail-kicker {
        display: block;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: var(--muted);
      }
      .detail-toolbar h1 {
        margin: 2px 0 0;
        font-size: 16px;
        font-weight: 600;
      }
      .detail-toolbar-actions {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .detail-body {
        min-width: 0;
        overflow: auto;
        padding: 18px;
        display: grid;
        gap: 18px;
        align-content: start;
      }
      .detail-section {
        border: 1px solid var(--line);
        background: var(--surface);
      }
      .section-titlebar {
        height: 44px;
        display: flex;
        align-items: center;
        padding: 0 14px;
        border-bottom: 1px solid var(--line);
      }
      .section-titlebar h2 {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
      }
      .editor-form,
      .property-list,
      .qr-layout {
        padding: 14px;
      }
      .editor-form {
        display: grid;
        gap: 12px;
      }
      .field-row {
        display: grid;
        grid-template-columns: 120px minmax(0, 1fr);
        align-items: center;
        gap: 12px;
      }
      .field-row span,
      .hint-copy,
      .toggle-row,
      .inline-note {
        font-size: 13px;
        color: var(--muted);
      }
      .field-row input {
        width: 100%;
        padding: 10px 12px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.03);
        color: var(--text);
      }
      .toggle-row {
        display: flex;
        gap: 10px;
        align-items: center;
        padding-left: 132px;
      }
      .editor-actions {
        display: flex;
        justify-content: flex-end;
      }
      .property-list {
        margin: 0;
        display: grid;
        gap: 1px;
      }
      .property-row {
        display: grid;
        grid-template-columns: 140px minmax(0, 1fr);
        gap: 14px;
        padding: 10px 0;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }
      .property-row:last-child { border-bottom: 0; }
      .property-row dt {
        color: var(--muted);
      }
      .property-row dd {
        margin: 0;
      }
      .inline-error {
        margin: 0;
        padding: 0 14px 14px;
        color: var(--danger);
      }
      .qr-layout {
        display: grid;
        grid-template-columns: 280px minmax(0, 1fr);
        gap: 18px;
        align-items: center;
      }
      .qr-image {
        width: 100%;
        max-width: 280px;
        background: white;
        padding: 16px;
      }
      .qr-copy {
        color: var(--muted);
        line-height: 1.6;
      }
      .qr-copy ol { margin: 0; padding-left: 18px; }
      .notice-strip,
      .error-strip {
        margin: 18px 18px 0;
        padding: 10px 14px;
        border: 1px solid var(--line);
        background: var(--surface);
      }
      .error-strip { color: var(--danger); }
      @media (max-width: 1100px) {
        main { grid-template-columns: 220px 240px minmax(0, 1fr); }
        .field-row { grid-template-columns: 96px minmax(0, 1fr); }
        .toggle-row { padding-left: 108px; }
        .qr-layout { grid-template-columns: 1fr; }
      }
      @media (max-width: 860px) {
        main { grid-template-columns: 1fr; }
        .adapters-rail { border-right: 0; border-bottom: 1px solid var(--line); }
        .detail-pane { grid-template-rows: auto minmax(0, 1fr); }
      }
    </style>
  </head>
  <body>
    <main>
      ${renderAdapterRail(routeBase, state, payload.statusByAdapter)}
      ${renderAccountRail(routeBase, state, adapter, accounts)}
      <div class="detail-shell">
        ${payload.notice ? `<div class="notice-strip">${escapeHtml(payload.notice)}</div>` : ""}
        ${payload.error ? `<div class="error-strip">${escapeHtml(payload.error)}</div>` : ""}
        ${renderDetailPane(routeBase, state, adapter, accounts, payload.challenge)}
      </div>
    </main>
  </body>
</html>`;
}

async function loadStatusByAdapter(kernel) {
  const results = await Promise.allSettled(
    ADAPTERS.map((adapter) => kernel.request("adapter.status", { adapter: adapter.id })),
  );
  const statusByAdapter = {};
  for (let index = 0; index < ADAPTERS.length; index += 1) {
    const adapter = ADAPTERS[index];
    const result = results[index];
    statusByAdapter[adapter.id] =
      result && result.status === "fulfilled" && Array.isArray(result.value?.accounts)
        ? result.value.accounts
        : [];
  }
  return statusByAdapter;
}

function requireAccountId(formData, adapterId, state) {
  const explicit = String(formData.get("accountId") ?? "").trim();
  if (explicit) return explicit;
  if (adapterId === "whatsapp") {
    return String(formData.get("whatsappAccountId") ?? state.whatsappAccountId ?? "").trim();
  }
  return String(formData.get("discordAccountId") ?? state.discordAccountId ?? "").trim();
}

function buildConnectConfig(adapterId, formData) {
  if (adapterId === "whatsapp") {
    const forceValue = String(formData.get("whatsappForce") ?? "");
    return forceValue === "true" || forceValue === "on" ? { force: true } : {};
  }
  const botToken = String(formData.get("discordBotToken") ?? "").trim();
  return botToken ? { botToken } : {};
}

export async function handleFetch(request, context = {}) {
  const props = context.props ?? {};
  const env = context.env ?? {};
  const kernel = props.kernel;
  if (!kernel) {
    return new Response("Adapters app requires kernel access.", { status: 500 });
  }

  const url = new URL(request.url);
  const routeBase = props.appFrame?.routeBase ?? env.PACKAGE_ROUTE_BASE ?? "/apps/adapters";
  let state = readState(url, null);
  let notice = "";
  let error = "";
  let challenge = null;

  if (request.method === "POST") {
    const formData = await request.formData();
    state = readState(url, formData);
    const rawAdapterId = String(formData.get("adapter") ?? "").trim();
    const adapterId = ADAPTER_IDS.has(rawAdapterId) ? rawAdapterId : state.adapter;
    const action = String(formData.get("action") ?? "").trim();

    try {
      if (action === "connect") {
        const accountId = requireAccountId(formData, adapterId, state);
        if (!accountId) {
          throw new Error("Account id is required.");
        }
        const result = await kernel.request("adapter.connect", {
          adapter: adapterId,
          accountId,
          config: buildConnectConfig(adapterId, formData),
        });
        if (!result?.ok) {
          throw new Error(String(result?.error ?? "Adapter connection failed."));
        }
        challenge = result.challenge ?? null;
        state.account = result.accountId || accountId;
        notice = result.message
          ? String(result.message)
          : challenge
            ? `Started ${adapterId} authentication for ${accountId}.`
            : `Connected ${adapterId}/${accountId}.`;
      } else if (action === "disconnect") {
        const accountId = requireAccountId(formData, adapterId, state);
        if (!accountId) {
          throw new Error("Account id is required.");
        }
        const result = await kernel.request("adapter.disconnect", {
          adapter: adapterId,
          accountId,
        });
        if (!result?.ok) {
          throw new Error(String(result?.error ?? "Adapter disconnect failed."));
        }
        state.account = "new";
        notice = result.message ? String(result.message) : `Disconnected ${adapterId}/${accountId}.`;
      } else if (action === "refresh") {
        const accountId = requireAccountId(formData, adapterId, state);
        await kernel.request("adapter.status", {
          adapter: adapterId,
          accountId: accountId || undefined,
        });
        notice = accountId ? `Refreshed ${adapterId}/${accountId}.` : `Refreshed ${adapterId} status.`;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  const statusByAdapter = await loadStatusByAdapter(kernel);
  return new Response(renderPage(routeBase, state, {
    notice,
    error,
    challenge,
    statusByAdapter,
  }), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
