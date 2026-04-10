const ADAPTERS = [
  {
    id: "whatsapp",
    name: "WhatsApp",
    eyebrow: "Personal messaging",
    summary: "Connect a phone by scanning a QR code. Best for direct messages and small-group interactions.",
    detail: "Use one account id per phone. The gateway keeps the account state and reconnects after the initial pairing.",
    accountLabel: "Connection name",
    accountPlaceholder: "primary",
    connectLabel: "Open QR flow",
    disconnectLabel: "Disconnect phone",
  },
  {
    id: "discord",
    name: "Discord",
    eyebrow: "Server and channel messaging",
    summary: "Connect a bot account with a token. Best for channels, threads, and community-style automation.",
    detail: "Bring a bot token here or leave it blank to use the deployment default if one is configured.",
    accountLabel: "Bot account name",
    accountPlaceholder: "main",
    connectLabel: "Connect bot",
    disconnectLabel: "Disconnect bot",
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
  if (value === null || value === undefined) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString();
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
  const whatsappForceValue = read("whatsappForce");
  return {
    adapter: ADAPTER_IDS.has(adapter) ? adapter : "whatsapp",
    whatsappAccountId: read("whatsappAccountId", "primary"),
    whatsappForce: whatsappForceValue === "true" || whatsappForceValue === "on",
    discordAccountId: read("discordAccountId", "main"),
    discordBotToken: read("discordBotToken"),
  };
}

function selectedAdapterDef(state) {
  return ADAPTERS.find((adapter) => adapter.id === state.adapter) ?? ADAPTERS[0];
}

function hiddenStateFields(state) {
  return [
    `<input type="hidden" name="adapter" value="${escapeHtml(state.adapter)}" />`,
    `<input type="hidden" name="whatsappAccountId" value="${escapeHtml(state.whatsappAccountId)}" />`,
    `<input type="hidden" name="whatsappForce" value="${state.whatsappForce ? "true" : ""}" />`,
    `<input type="hidden" name="discordAccountId" value="${escapeHtml(state.discordAccountId)}" />`,
  ].join("");
}

function hrefWithState(routeBase, state, overrides = {}) {
  const url = new URL(`http://local${routeBase}`);
  const next = {
    adapter: state.adapter,
    whatsappAccountId: state.whatsappAccountId,
    whatsappForce: state.whatsappForce ? "true" : "",
    discordAccountId: state.discordAccountId,
    ...overrides,
  };
  for (const [key, value] of Object.entries(next)) {
    if (value === null || value === undefined || String(value).length === 0) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

function countConnected(accounts) {
  let connected = 0;
  for (const account of accounts) {
    if (account?.connected) {
      connected += 1;
    }
  }
  return connected;
}

function renderAdapterNav(routeBase, state, statusByAdapter) {
  return `
    <nav class="adapters-nav" aria-label="Adapter types">
      ${ADAPTERS.map((adapter) => {
        const accounts = statusByAdapter[adapter.id] ?? [];
        const connected = countConnected(accounts);
        return `
          <a class="adapters-nav-card ${state.adapter === adapter.id ? "is-active" : ""}" href="${escapeHtml(hrefWithState(routeBase, state, { adapter: adapter.id }))}">
            <span class="adapters-nav-eyebrow">${escapeHtml(adapter.eyebrow)}</span>
            <strong>${escapeHtml(adapter.name)}</strong>
            <span class="adapters-nav-copy">${escapeHtml(adapter.summary)}</span>
            <span class="adapters-nav-meta">${accounts.length} known · ${connected} connected</span>
          </a>
        `;
      }).join("")}
    </nav>
  `;
}

function renderAccountStatus(account) {
  const pills = [
    `<span class="adapters-pill ${account.connected ? "is-good" : "is-muted"}">${account.connected ? "connected" : "offline"}</span>`,
    `<span class="adapters-pill ${account.authenticated ? "is-good" : "is-warn"}">${account.authenticated ? "authenticated" : "needs auth"}</span>`,
  ];
  if (account.mode) {
    pills.push(`<span class="adapters-pill">${escapeHtml(account.mode)}</span>`);
  }
  return pills.join("");
}

function renderAccountMeta(adapterId, account) {
  const items = [`<code>${escapeHtml(account.accountId)}</code>`];
  if (account.lastActivity) {
    items.push(`last activity ${escapeHtml(formatTimestampMs(account.lastActivity))}`);
  }
  if (adapterId === "whatsapp") {
    const selfE164 = String(account?.extra?.selfE164 ?? "").trim();
    const selfJid = String(account?.extra?.selfJid ?? "").trim();
    if (selfE164) {
      items.push(`phone ${escapeHtml(selfE164)}`);
    } else if (selfJid) {
      items.push(`jid ${escapeHtml(selfJid)}`);
    }
  }
  return items.join(' <span class="adapters-meta-sep">•</span> ');
}

function renderAccounts(routeBase, state, adapter, accounts) {
  if (accounts.length === 0) {
    return `
      <section class="adapters-section">
        <div class="adapters-section-head">
          <div>
            <p class="adapters-eyebrow">Known accounts</p>
            <h2>No ${escapeHtml(adapter.name)} accounts yet</h2>
          </div>
          <p class="adapters-muted">Connect the first account above. Once an adapter has reported status, it shows up here for reconnect, review, and disconnect operations.</p>
        </div>
      </section>
    `;
  }

  return `
    <section class="adapters-section">
      <div class="adapters-section-head">
        <div>
          <p class="adapters-eyebrow">Known accounts</p>
          <h2>${escapeHtml(adapter.name)} connections</h2>
        </div>
        <p class="adapters-muted">These are the last known account states held by the gateway.</p>
      </div>
      <div class="adapters-account-grid">
        ${accounts.map((account) => `
          <article class="adapters-account-card">
            <div class="adapters-account-header">
              <div>
                <h3>${escapeHtml(account.accountId)}</h3>
                <p class="adapters-meta">${renderAccountMeta(adapter.id, account)}</p>
              </div>
              <div class="adapters-pill-row">${renderAccountStatus(account)}</div>
            </div>
            ${account.error ? `<p class="adapters-error-inline">${escapeHtml(account.error)}</p>` : ""}
            <div class="adapters-account-actions">
              <a class="adapters-btn adapters-btn-quiet" href="${escapeHtml(hrefWithState(routeBase, state, adapter.id === "whatsapp"
                ? { adapter: adapter.id, whatsappAccountId: account.accountId }
                : { adapter: adapter.id, discordAccountId: account.accountId }))}">Use this account</a>
              <form method="post">
                ${hiddenStateFields(state)}
                <input type="hidden" name="action" value="refresh" />
                <input type="hidden" name="adapter" value="${escapeHtml(adapter.id)}" />
                <input type="hidden" name="accountId" value="${escapeHtml(account.accountId)}" />
                <button type="submit" class="adapters-btn adapters-btn-quiet">Refresh</button>
              </form>
              <form method="post">
                ${hiddenStateFields(state)}
                <input type="hidden" name="action" value="disconnect" />
                <input type="hidden" name="adapter" value="${escapeHtml(adapter.id)}" />
                <input type="hidden" name="accountId" value="${escapeHtml(account.accountId)}" />
                <button type="submit" class="adapters-btn adapters-btn-danger">Disconnect</button>
              </form>
            </div>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderChallenge(challenge) {
  if (!challenge) {
    return "";
  }

  if (challenge.type === "qr" && challenge.data) {
    return `
      <section class="adapters-section adapters-challenge-section">
        <div class="adapters-section-head">
          <div>
            <p class="adapters-eyebrow">Authentication required</p>
            <h2>Scan the QR code</h2>
          </div>
          <p class="adapters-muted">${escapeHtml(challenge.message || "Open WhatsApp on your phone, then scan this code from Linked Devices.")}</p>
        </div>
        <div class="adapters-qr-layout">
          <img class="adapters-qr" src="${escapeHtml(challenge.data)}" alt="WhatsApp QR code" />
          <div class="adapters-qr-copy">
            <ol>
              <li>Open WhatsApp on your phone.</li>
              <li>Go to Linked Devices.</li>
              <li>Scan this code before it expires.</li>
            </ol>
          </div>
        </div>
      </section>
    `;
  }

  return `
    <section class="adapters-section adapters-challenge-section">
      <div class="adapters-section-head">
        <div>
          <p class="adapters-eyebrow">Adapter challenge</p>
          <h2>${escapeHtml(challenge.type || "Additional action required")}</h2>
        </div>
        <p class="adapters-muted">${escapeHtml(challenge.message || "Complete the adapter challenge, then refresh status.")}</p>
      </div>
      <pre class="adapters-challenge-dump">${escapeHtml(JSON.stringify(challenge, null, 2))}</pre>
    </section>
  `;
}

function renderConnectForm(state, adapter) {
  if (adapter.id === "whatsapp") {
    return `
      <form method="post" class="adapters-form">
        ${hiddenStateFields(state)}
        <input type="hidden" name="action" value="connect" />
        <input type="hidden" name="adapter" value="whatsapp" />
        <label class="adapters-field">
          <span>${escapeHtml(adapter.accountLabel)}</span>
          <input type="text" name="whatsappAccountId" value="${escapeHtml(state.whatsappAccountId)}" placeholder="${escapeHtml(adapter.accountPlaceholder)}" spellcheck="false" required />
        </label>
        <label class="adapters-checkbox">
          <input type="checkbox" name="whatsappForce" value="true" ${state.whatsappForce ? "checked" : ""} />
          <span>Force a fresh QR session</span>
        </label>
        <div class="adapters-actions">
          <button type="submit" class="adapters-btn adapters-btn-primary">${escapeHtml(adapter.connectLabel)}</button>
        </div>
      </form>
    `;
  }

  return `
    <form method="post" class="adapters-form">
      ${hiddenStateFields(state)}
      <input type="hidden" name="action" value="connect" />
      <input type="hidden" name="adapter" value="discord" />
      <label class="adapters-field">
        <span>${escapeHtml(adapter.accountLabel)}</span>
        <input type="text" name="discordAccountId" value="${escapeHtml(state.discordAccountId)}" placeholder="${escapeHtml(adapter.accountPlaceholder)}" spellcheck="false" required />
      </label>
      <label class="adapters-field">
        <span>Bot token</span>
        <input type="password" name="discordBotToken" value="" placeholder="Leave blank to use the deployment default" />
      </label>
      <p class="adapters-muted">This connects immediately if the bot token is valid. It does not use a QR or browser login flow.</p>
      <div class="adapters-actions">
        <button type="submit" class="adapters-btn adapters-btn-primary">${escapeHtml(adapter.connectLabel)}</button>
      </div>
    </form>
  `;
}

function renderSelectedAdapter(routeBase, state, adapter, accounts) {
  const accountId = adapter.id === "whatsapp" ? state.whatsappAccountId : state.discordAccountId;
  return `
    <section class="adapters-section adapters-hero">
      <div>
        <p class="adapters-eyebrow">${escapeHtml(adapter.eyebrow)}</p>
        <h1>${escapeHtml(adapter.name)}</h1>
        <p class="adapters-lead">${escapeHtml(adapter.summary)}</p>
        <p class="adapters-muted">${escapeHtml(adapter.detail)}</p>
      </div>
      <div class="adapters-hero-actions">
        <form method="post">
          ${hiddenStateFields(state)}
          <input type="hidden" name="action" value="refresh" />
          <input type="hidden" name="adapter" value="${escapeHtml(adapter.id)}" />
          <input type="hidden" name="accountId" value="${escapeHtml(accountId)}" />
          <button type="submit" class="adapters-btn adapters-btn-quiet">Refresh status</button>
        </form>
        <form method="post">
          ${hiddenStateFields(state)}
          <input type="hidden" name="action" value="disconnect" />
          <input type="hidden" name="adapter" value="${escapeHtml(adapter.id)}" />
          <input type="hidden" name="accountId" value="${escapeHtml(accountId)}" />
          <button type="submit" class="adapters-btn adapters-btn-danger">${escapeHtml(adapter.disconnectLabel)}</button>
        </form>
      </div>
    </section>
    <section class="adapters-section">
      <div class="adapters-section-head">
        <div>
          <p class="adapters-eyebrow">Setup</p>
          <h2>Connect ${escapeHtml(adapter.name)}</h2>
        </div>
      </div>
      ${renderConnectForm(state, adapter)}
    </section>
    ${renderAccounts(routeBase, state, adapter, accounts)}
  `;
}

function renderPage(routeBase, state, payload) {
  const adapter = selectedAdapterDef(state);
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
        --panel-strong: rgba(12, 25, 33, 0.9);
        --panel-soft: rgba(16, 36, 47, 0.82);
        --edge-strong: rgba(138, 224, 255, 0.24);
        --edge-soft: rgba(138, 224, 255, 0.14);
        --good: #7dd3a7;
        --warn: #f7c66e;
        --danger: #ff8f8f;
      }
      body { margin: 0; min-height: 100vh; }
      main { max-width: 1180px; margin: 0 auto; padding: 28px; }
      .adapters-frame { display: grid; gap: 18px; }
      .adapters-nav { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
      .adapters-nav-card,
      .adapters-section,
      .adapters-account-card {
        border: 1px solid var(--edge-soft);
        background: var(--panel-soft);
        border-radius: 18px;
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.24);
      }
      .adapters-nav-card {
        display: grid;
        gap: 8px;
        padding: 18px;
        color: inherit;
        text-decoration: none;
      }
      .adapters-nav-card.is-active {
        border-color: var(--edge-strong);
        background: linear-gradient(180deg, rgba(22, 49, 61, 0.96), rgba(12, 25, 33, 0.92));
      }
      .adapters-nav-eyebrow,
      .adapters-eyebrow {
        margin: 0;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        font-size: 11px;
        color: var(--muted);
      }
      .adapters-nav-copy,
      .adapters-muted { color: var(--muted); line-height: 1.5; }
      .adapters-nav-meta { font-size: 13px; color: var(--accent); }
      .adapters-section { padding: 22px; }
      .adapters-hero { display: flex; justify-content: space-between; gap: 20px; align-items: start; }
      .adapters-hero h1,
      .adapters-section h2,
      .adapters-account-card h3 { margin: 6px 0 0; }
      .adapters-lead { max-width: 72ch; line-height: 1.6; }
      .adapters-section-head { display: flex; justify-content: space-between; gap: 20px; align-items: start; margin-bottom: 18px; }
      .adapters-form { display: grid; gap: 16px; max-width: 560px; }
      .adapters-field { display: grid; gap: 8px; }
      .adapters-field span { font-size: 13px; color: var(--muted); }
      .adapters-field input {
        width: 100%;
        padding: 12px 14px;
        border-radius: 12px;
        border: 1px solid var(--edge-soft);
        background: rgba(4, 11, 15, 0.72);
        color: var(--text);
      }
      .adapters-checkbox { display: flex; gap: 10px; align-items: center; color: var(--text); }
      .adapters-actions,
      .adapters-hero-actions,
      .adapters-account-actions { display: flex; gap: 10px; flex-wrap: wrap; }
      .adapters-btn {
        appearance: none;
        border: 1px solid var(--edge-soft);
        border-radius: 999px;
        padding: 10px 14px;
        background: rgba(7, 18, 24, 0.9);
        color: var(--text);
        text-decoration: none;
        font: inherit;
        cursor: pointer;
      }
      .adapters-btn-primary {
        background: linear-gradient(180deg, rgba(138, 224, 255, 0.2), rgba(138, 224, 255, 0.1));
        border-color: var(--edge-strong);
      }
      .adapters-btn-danger { border-color: rgba(255, 143, 143, 0.28); color: #ffd0d0; }
      .adapters-btn-quiet { background: rgba(255, 255, 255, 0.03); }
      .adapters-account-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
      .adapters-account-card { padding: 18px; display: grid; gap: 14px; }
      .adapters-account-header { display: flex; justify-content: space-between; gap: 12px; align-items: start; }
      .adapters-meta { color: var(--muted); font-size: 13px; line-height: 1.5; }
      .adapters-meta-sep { color: rgba(255, 255, 255, 0.2); margin: 0 6px; }
      .adapters-pill-row { display: flex; gap: 8px; flex-wrap: wrap; justify-content: end; }
      .adapters-pill {
        display: inline-flex;
        padding: 5px 10px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.06);
        color: var(--text);
        font-size: 12px;
      }
      .adapters-pill.is-good { color: var(--good); }
      .adapters-pill.is-warn { color: var(--warn); }
      .adapters-pill.is-muted { color: var(--muted); }
      .adapters-error-inline,
      .adapters-error-card { color: var(--danger); }
      .adapters-notice-card,
      .adapters-error-card {
        padding: 14px 18px;
        border-radius: 14px;
        border: 1px solid var(--edge-soft);
        background: var(--panel-strong);
      }
      .adapters-challenge-section { border-color: var(--edge-strong); }
      .adapters-qr-layout { display: flex; gap: 24px; flex-wrap: wrap; align-items: center; }
      .adapters-qr {
        width: min(320px, 100%);
        aspect-ratio: 1;
        object-fit: contain;
        border-radius: 16px;
        background: white;
        padding: 18px;
      }
      .adapters-qr-copy { max-width: 34ch; }
      .adapters-qr-copy ol { margin: 0; padding-left: 20px; line-height: 1.7; }
      .adapters-challenge-dump { overflow: auto; padding: 14px; border-radius: 12px; background: rgba(0, 0, 0, 0.3); }
      @media (max-width: 900px) {
        main { padding: 18px; }
        .adapters-hero,
        .adapters-section-head,
        .adapters-account-header { display: grid; grid-template-columns: 1fr; }
        .adapters-pill-row { justify-content: start; }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="adapters-frame">
        ${renderAdapterNav(routeBase, state, payload.statusByAdapter)}
        ${payload.notice ? `<section class="adapters-notice-card">${escapeHtml(payload.notice)}</section>` : ""}
        ${payload.error ? `<section class="adapters-error-card">${escapeHtml(payload.error)}</section>` : ""}
        ${renderChallenge(payload.challenge)}
        ${renderSelectedAdapter(routeBase, state, adapter, accounts)}
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
  if (explicit) {
    return explicit;
  }
  if (adapterId === "whatsapp") {
    return String(formData.get("whatsappAccountId") ?? state.whatsappAccountId ?? "").trim();
  }
  return String(formData.get("discordAccountId") ?? state.discordAccountId ?? "").trim();
}

function buildConnectConfig(adapterId, formData, state) {
  if (adapterId === "whatsapp") {
    const formValue = String(formData.get("whatsappForce") ?? "");
    const force = formData.has("whatsappForce")
      ? formValue === "true" || formValue === "on"
      : state.whatsappForce;
    return force ? { force: true } : {};
  }
  const botToken = String(formData.get("discordBotToken") ?? state.discordBotToken ?? "").trim();
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
          config: buildConnectConfig(adapterId, formData, state),
        });
        if (!result?.ok) {
          throw new Error(String(result?.error ?? "Adapter connection failed."));
        }
        challenge = result.challenge ?? null;
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

  state.discordBotToken = "";

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
