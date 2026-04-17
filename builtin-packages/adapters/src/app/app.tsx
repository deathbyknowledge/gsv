import { useEffect, useMemo, useState } from "preact/hooks";
import type {
  AdapterAccount,
  AdapterConnectChallenge,
  AdapterKind,
  AdaptersBackend,
  AdaptersState,
} from "./types";

const ADAPTERS: Array<{
  id: AdapterKind;
  name: string;
  icon: string;
  summary: string;
  detail: string;
  accountPlaceholder: string;
}> = [
  {
    id: "whatsapp",
    name: "WhatsApp",
    icon: "◉",
    summary: "Phone-linked direct messages and groups.",
    detail: "Pair once, keep the gateway session alive, and route inbound conversations into GSV.",
    accountPlaceholder: "primary",
  },
  {
    id: "discord",
    name: "Discord",
    icon: "◎",
    summary: "Bot-driven channels, DMs, and communities.",
    detail: "Attach a bot identity, monitor its health, and manage which account GSV uses for outbound replies.",
    accountPlaceholder: "main",
  },
];

const EMPTY_STATE: AdaptersState = {
  statusByAdapter: {
    whatsapp: [],
    discord: [],
  },
};

export function App({ backend }: { backend: AdaptersBackend }) {
  const [state, setState] = useState<AdaptersState>(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedAdapter, setSelectedAdapter] = useState<AdapterKind>(readAdapterFromLocation());
  const [selectedAccount, setSelectedAccount] = useState<string>(readAccountFromLocation());
  const [challenge, setChallenge] = useState<{ adapter: AdapterKind; accountId: string; value: AdapterConnectChallenge } | null>(null);
  const [whatsappName, setWhatsappName] = useState("");
  const [whatsappForce, setWhatsappForce] = useState(false);
  const [discordName, setDiscordName] = useState("");
  const [discordToken, setDiscordToken] = useState("");

  const adapterMeta = useMemo(() => ADAPTERS.find((adapter) => adapter.id === selectedAdapter) ?? ADAPTERS[0], [selectedAdapter]);
  const accounts = state.statusByAdapter[selectedAdapter] ?? [];

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const preferred = selectedAccount.trim();
    if (preferred && preferred !== "new" && accounts.some((account) => account.accountId === preferred)) {
      return;
    }
    if (preferred === "new") {
      return;
    }
    setSelectedAccount(accounts[0]?.accountId ?? "new");
  }, [selectedAdapter, accounts]);

  useEffect(() => {
    writeLocation(selectedAdapter, selectedAccount);
  }, [selectedAdapter, selectedAccount]);

  useEffect(() => {
    if (!whatsappName) {
      setWhatsappName("primary");
    }
    if (!discordName) {
      setDiscordName("main");
    }
  }, []);

  const currentAccount = selectedAccount === "new"
    ? null
    : accounts.find((account) => account.accountId === selectedAccount) ?? null;
  const visibleChallenge = challenge
    && challenge.adapter === selectedAdapter
    && challenge.accountId === (currentAccount?.accountId ?? selectedAccount)
    ? challenge.value
    : null;

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const next = await backend.loadState();
      setState(next);
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setLoading(false);
    }
  }

  async function runMutation(task: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await task();
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function submitConnect(event: Event): Promise<void> {
    event.preventDefault();
    await runMutation(async () => {
      const accountId = selectedAdapter === "whatsapp" ? whatsappName.trim() : discordName.trim();
      const config = selectedAdapter === "whatsapp"
        ? { force: whatsappForce }
        : discordToken.trim()
          ? { botToken: discordToken.trim() }
          : undefined;
      const result = await backend.connectAccount({
        adapter: selectedAdapter,
        accountId,
        config,
      });
      setNotice(result.statusText);
      if (result.challenge) {
        setChallenge({ adapter: selectedAdapter, accountId, value: result.challenge });
      } else {
        setChallenge(null);
      }
      if (!result.ok) {
        setError(result.error || result.statusText);
        return;
      }
      if (selectedAdapter === "discord") {
        setDiscordToken("");
      }
      await refresh();
      setSelectedAccount(accountId);
    });
  }

  async function disconnectCurrentAccount(): Promise<void> {
    if (!currentAccount) return;
    await runMutation(async () => {
      const result = await backend.disconnectAccount({
        adapter: selectedAdapter,
        accountId: currentAccount.accountId,
      });
      setNotice(result.statusText);
      if (!result.ok) {
        setError(result.error || result.statusText);
        return;
      }
      setChallenge(null);
      await refresh();
      setSelectedAccount("new");
    });
  }

  return (
    <div class="adapters-shell">
      <aside class="adapters-pane adapters-pane--primary">
        <header class="adapters-pane-head">
          <div>
            <h1>Adapters</h1>
            <p>Connect message surfaces that can route conversations into GSV.</p>
          </div>
        </header>
        <nav class="adapters-list" aria-label="Adapters">
          {ADAPTERS.map((adapter) => {
            const adapterAccounts = state.statusByAdapter[adapter.id] ?? [];
            const connectedCount = adapterAccounts.filter((account) => account.connected).length;
            const tone = connectedCount > 0 ? "is-good" : adapterAccounts.length > 0 ? "is-warn" : "is-idle";
            return (
              <button
                key={adapter.id}
                type="button"
                class={`adapter-row${selectedAdapter === adapter.id ? " is-active" : ""}`}
                onClick={() => {
                  setSelectedAdapter(adapter.id);
                  setNotice(null);
                  setError(null);
                }}
              >
                <span class="adapter-row-icon">{adapter.icon}</span>
                <span class="adapter-row-copy">
                  <strong>{adapter.name}</strong>
                  <span>{adapter.summary}</span>
                </span>
                <span class={`adapter-dot ${tone}`}></span>
              </button>
            );
          })}
        </nav>
      </aside>

      <aside class="adapters-pane adapters-pane--secondary">
        <header class="adapters-pane-head adapters-pane-head--tight">
          <div>
            <h2>{adapterMeta.name}</h2>
            <p>{adapterMeta.detail}</p>
          </div>
          <button
            type="button"
            class={`adapters-icon-button${selectedAccount === "new" ? " is-active" : ""}`}
            onClick={() => setSelectedAccount("new")}
            title="New connection"
            aria-label="New connection"
          >
            ＋
          </button>
        </header>
        <div class="account-list">
          <button
            type="button"
            class={`account-row${selectedAccount === "new" ? " is-active" : ""}`}
            onClick={() => setSelectedAccount("new")}
          >
            <span class="account-row-icon">＋</span>
            <span class="account-row-copy">
              <strong>New connection</strong>
              <span>{adapterMeta.detail}</span>
            </span>
          </button>
          {accounts.map((account) => (
            <button
              key={account.accountId}
              type="button"
              class={`account-row${selectedAccount === account.accountId ? " is-active" : ""}`}
              onClick={() => setSelectedAccount(account.accountId)}
            >
              <span class="account-row-icon">{adapterMeta.icon}</span>
              <span class="account-row-copy">
                <strong>{account.accountId}</strong>
                <span>{account.connected ? "Connected" : account.authenticated ? "Authenticated" : "Needs attention"}</span>
              </span>
              <span class={`adapter-dot ${account.connected ? "is-good" : account.authenticated ? "is-warn" : "is-idle"}`}></span>
            </button>
          ))}
        </div>
      </aside>

      <main class="adapters-detail">
        <header class="adapters-detail-head">
          <div>
            <span class="adapters-kicker">{adapterMeta.name}</span>
            <h2>{currentAccount ? currentAccount.accountId : "New connection"}</h2>
          </div>
          <div class="adapters-actions">
            <button type="button" class="adapters-icon-button" onClick={() => void refresh()} disabled={loading || busy} title="Refresh status" aria-label="Refresh status">
              ↻
            </button>
            {currentAccount ? (
              <button type="button" class="adapters-icon-button" onClick={() => void disconnectCurrentAccount()} disabled={busy} title="Disconnect" aria-label="Disconnect">
                ⏻
              </button>
            ) : null}
          </div>
        </header>

        <div class="adapters-detail-body">
          {loading ? <div class="adapters-empty-state">Loading adapter status…</div> : null}
          {!loading && error ? <div class="adapters-inline-status is-error">{error}</div> : null}
          {!loading && !error && notice ? <div class="adapters-inline-status is-info">{notice}</div> : null}

          {!loading ? (
            currentAccount ? (
              <>
                <section class="adapters-section">
                  <header>
                    <h3>Overview</h3>
                    <p>Connection health and the last known account state.</p>
                  </header>
                  <div class="adapters-info-grid">
                    <article>
                      <span>Connection</span>
                      <strong>{currentAccount.connected ? "Connected" : "Offline"}</strong>
                    </article>
                    <article>
                      <span>Authentication</span>
                      <strong>{currentAccount.authenticated ? "Authenticated" : "Needs attention"}</strong>
                    </article>
                    <article>
                      <span>Mode</span>
                      <strong>{currentAccount.mode || "Unknown"}</strong>
                    </article>
                    <article>
                      <span>Last activity</span>
                      <strong>{formatTimestamp(currentAccount.lastActivity)}</strong>
                    </article>
                  </div>
                  {currentAccount.error ? <p class="adapters-inline-status is-error">{currentAccount.error}</p> : null}
                </section>

                <section class="adapters-section">
                  <header>
                    <h3>Identity</h3>
                    <p>Account details GSV currently knows about this adapter session.</p>
                  </header>
                  <dl class="adapters-property-list">
                    {describeAccount(adapterMeta.id, currentAccount).map(([label, value]) => (
                      <div class="adapters-property-row" key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>

                {visibleChallenge ? (
                  <ChallengeSection adapter={adapterMeta.id} challenge={visibleChallenge} />
                ) : null}
              </>
            ) : (
              <>
                <section class="adapters-section">
                  <header>
                    <h3>Connect {adapterMeta.name}</h3>
                    <p>{adapterMeta.detail}</p>
                  </header>
                  <form class="adapters-form" onSubmit={(event) => void submitConnect(event)}>
                    <label>
                      <span>Name</span>
                      {selectedAdapter === "whatsapp" ? (
                        <input value={whatsappName} onInput={(event) => setWhatsappName((event.currentTarget as HTMLInputElement).value)} placeholder={adapterMeta.accountPlaceholder} required />
                      ) : (
                        <input value={discordName} onInput={(event) => setDiscordName((event.currentTarget as HTMLInputElement).value)} placeholder={adapterMeta.accountPlaceholder} required />
                      )}
                    </label>

                    {selectedAdapter === "whatsapp" ? (
                      <label class="adapters-toggle-row">
                        <input type="checkbox" checked={whatsappForce} onChange={(event) => setWhatsappForce((event.currentTarget as HTMLInputElement).checked)} />
                        <span>Force a fresh QR session</span>
                      </label>
                    ) : (
                      <label>
                        <span>Bot token</span>
                        <input type="password" value={discordToken} onInput={(event) => setDiscordToken((event.currentTarget as HTMLInputElement).value)} placeholder="Leave blank to use the deployment default" />
                      </label>
                    )}

                    <div class="adapters-form-actions">
                      <button type="submit" class="adapters-primary-button" disabled={busy}>
                        {selectedAdapter === "whatsapp" ? "Open pairing flow" : "Connect bot"}
                      </button>
                    </div>
                  </form>
                </section>

                {visibleChallenge ? <ChallengeSection adapter={adapterMeta.id} challenge={visibleChallenge} /> : null}
              </>
            )
          ) : null}
        </div>
      </main>
    </div>
  );
}

function ChallengeSection(props: { adapter: AdapterKind; challenge: AdapterConnectChallenge }) {
  const { adapter, challenge } = props;
  return (
    <section class="adapters-section">
      <header>
        <h3>{challenge.type === "qr" ? "Pair device" : "Next step"}</h3>
        <p>{challenge.message || `Complete the ${adapter} authentication flow, then refresh status.`}</p>
      </header>
      {challenge.type === "qr" && challenge.data ? (
        <div class="adapters-challenge-layout">
          <pre class="adapters-challenge-code">{challenge.data}</pre>
          <div class="adapters-challenge-copy">
            <strong>Pairing instructions</strong>
            <ol>
              <li>Open the app on your phone.</li>
              <li>Open linked devices.</li>
              <li>Scan the QR code shown here.</li>
            </ol>
          </div>
        </div>
      ) : null}
      {challenge.type !== "qr" && challenge.data ? <pre class="adapters-challenge-code">{challenge.data}</pre> : null}
      {challenge.expiresAt ? <p class="adapters-hint">Expires {formatTimestamp(challenge.expiresAt)}</p> : null}
    </section>
  );
}

function readAdapterFromLocation(): AdapterKind {
  const value = new URL(window.location.href).searchParams.get("adapter");
  return value === "discord" ? "discord" : "whatsapp";
}

function readAccountFromLocation(): string {
  const value = new URL(window.location.href).searchParams.get("account");
  return value && value.trim() ? value.trim() : "";
}

function writeLocation(adapter: AdapterKind, account: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("adapter", adapter);
  if (account && account !== "new") {
    url.searchParams.set("account", account);
  } else {
    url.searchParams.delete("account");
  }
  window.history.replaceState({}, "", `${url.pathname}${url.search}`);
}

function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatTimestamp(value: number | undefined): string {
  if (!value || !Number.isFinite(value)) return "—";
  return new Date(value).toLocaleString();
}

function describeAccount(adapter: AdapterKind, account: AdapterAccount): Array<[string, string]> {
  const rows: Array<[string, string]> = [["Account", account.accountId]];
  const extras = account.extra ?? {};
  if (adapter === "whatsapp") {
    const phone = typeof extras.selfE164 === "string" ? extras.selfE164.trim() : "";
    const jid = typeof extras.selfJid === "string" ? extras.selfJid.trim() : "";
    if (phone) rows.push(["Phone", phone]);
    if (jid) rows.push(["JID", jid]);
  }
  for (const [key, value] of Object.entries(extras)) {
    if (key === "selfE164" || key === "selfJid") continue;
    if (value === null || value === undefined || value === "") continue;
    rows.push([humanizeKey(key), String(value)]);
  }
  if (rows.length === 1) {
    rows.push(["Details", "No extra identity details reported."]);
  }
  return rows;
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .replace(/^./, (value) => value.toUpperCase());
}
