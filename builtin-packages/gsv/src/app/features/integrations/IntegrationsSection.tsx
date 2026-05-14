import qrcode from "qrcode-generator";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { GsvBackend } from "../../backend-contract";
import { ActionButton } from "../../components/ui/ActionButton";
import { Icon, type IconName } from "../../components/ui/Icon";
import { formatTimestampMs } from "../../utils/format";
import {
  ADAPTERS,
  describeAccount,
  getAccountStatus,
  getAccountTone,
  getAdapterTone,
} from "./integrations-domain";
import { McpServersDetail, McpServersSummary } from "./McpServersPane";
import { readyServerCount } from "./mcp-domain";
import type { AdapterAccount, AdapterConnectChallenge, AdapterKind, IntegrationKind } from "./types";
import { useMcpServers } from "./useMcpServers";
import { useMessageAdapters } from "./useMessageAdapters";

export function IntegrationsSection({ backend }: { backend: GsvBackend }) {
  const adaptersRuntime = useMessageAdapters(backend);
  const mcpRuntime = useMcpServers(backend);
  const [kind, setKind] = useState<IntegrationKind | null>(readIntegrationKindFromLocation);
  const busy = kind === null
    ? adaptersRuntime.loading || adaptersRuntime.busy || mcpRuntime.loading || mcpRuntime.pendingAction !== null
    : kind === "message-adapters"
    ? adaptersRuntime.loading || adaptersRuntime.busy
    : mcpRuntime.loading || mcpRuntime.pendingAction !== null;

  useEffect(() => {
    const onPopState = () => setKind(readIntegrationKindFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function selectKind(nextKind: IntegrationKind): void {
    setKind(nextKind);
    const url = new URL(window.location.href);
    url.searchParams.set("section", "integrations");
    url.searchParams.set("type", nextKind);
    window.history.pushState({}, "", url);
  }

  function showIntegrationList(): void {
    setKind(null);
    const url = new URL(window.location.href);
    url.searchParams.set("section", "integrations");
    url.searchParams.delete("type");
    url.searchParams.delete("adapter");
    url.searchParams.delete("account");
    url.searchParams.delete("mcpServer");
    window.history.pushState({}, "", url);
  }

  function refreshActiveKind(): void {
    if (kind === null) {
      void adaptersRuntime.refresh();
      void mcpRuntime.refresh();
    } else if (kind === "message-adapters") {
      void adaptersRuntime.refresh();
    } else {
      void mcpRuntime.refresh();
    }
  }

  if (kind === "message-adapters") {
    return (
      <section class="gsv-integrations">
        <MessageAdapterDetail runtime={adaptersRuntime} onBack={showIntegrationList} />
      </section>
    );
  }

  if (kind === "mcp-servers") {
    return (
      <section class="gsv-integrations">
        {mcpRuntime.selectedServer ? (
          <McpServersDetail runtime={mcpRuntime} onBack={() => mcpRuntime.setSelectedServerId(null)} />
        ) : (
          <McpServersSummary runtime={mcpRuntime} onBack={showIntegrationList} />
        )}
      </section>
    );
  }

  const connectedAccounts = countConnectedAccounts(adaptersRuntime.state.statusByAdapter);
  const totalAccounts = Object.values(adaptersRuntime.state.statusByAdapter).reduce((total, accounts) => total + accounts.length, 0);
  const readyServers = readyServerCount(mcpRuntime.state.servers);
  const totalServers = mcpRuntime.state.servers.length;
  const connectedAccountsLabel = totalAccounts > 0 ? `of ${totalAccounts} account${totalAccounts === 1 ? "" : "s"}` : "connected";
  const readyServersLabel = totalServers > 0 ? `of ${totalServers} server${totalServers === 1 ? "" : "s"}` : "ready";

  return (
    <section class="gsv-integrations">
      <aside class="gsv-integrations-nav is-list-view" aria-label="Integration categories">
        <header class="gsv-integrations-nav-head">
          <div>
            <span class="gsv-kicker">Extensions</span>
            <h3>Integrations</h3>
          </div>
          <ActionButton icon="refresh" label="Refresh" size="icon" busy={busy} onClick={refreshActiveKind} />
        </header>

        <div class="gsv-integration-kind-list">
          <IntegrationKindCard
            icon="plug"
            title="Message adapters"
            detail="WhatsApp and Discord accounts for inbound and outbound channels."
            value={String(connectedAccounts)}
            valueLabel={connectedAccountsLabel}
            onOpen={() => selectKind("message-adapters")}
          />
          <IntegrationKindCard
            icon="server"
            title="MCP servers"
            detail="Tool server configuration and CodeMode tool availability."
            value={String(readyServers)}
            valueLabel={readyServersLabel}
            onOpen={() => selectKind("mcp-servers")}
          />
        </div>
      </aside>
    </section>
  );
}

function IntegrationKindCard({
  icon,
  title,
  detail,
  value,
  valueLabel,
  onOpen,
}: {
  icon: IconName;
  title: string;
  detail: string;
  value: string;
  valueLabel: string;
  onOpen: () => void;
}) {
  return (
    <button type="button" class="gsv-integration-kind-card" aria-label={`Open ${title}`} onClick={onOpen}>
      <span class="gsv-integration-kind-icon"><Icon name={icon} /></span>
      <span class="gsv-row-copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </span>
      <span class="gsv-integration-kind-stat">
        <strong>{value}</strong>
        <span>{valueLabel}</span>
      </span>
    </button>
  );
}

function MessageAdapterDetail({ runtime, onBack }: { runtime: ReturnType<typeof useMessageAdapters>; onBack: () => void }) {
  return (
    <section class="gsv-integration-detail" aria-label={`${runtime.adapterMeta.name} accounts`}>
      <header class="gsv-integration-detail-head">
        <ActionButton icon="arrow-left" label="Integrations" onClick={onBack} />
        <div>
          <span class="gsv-kicker">{runtime.adapterMeta.name}</span>
          <h3>{runtime.currentAccount ? runtime.currentAccount.accountId : "New connection"}</h3>
          <p>{runtime.adapterMeta.detail}</p>
        </div>
        {runtime.currentAccount ? (
          <ActionButton
            icon="x"
            label="Disconnect"
            variant="danger"
            disabled={runtime.busy}
            onClick={() => void runtime.disconnectCurrentAccount()}
          />
        ) : null}
      </header>

      {runtime.loading ? <p class="gsv-runtime-meta">Loading adapter status...</p> : null}
      {!runtime.loading && runtime.error ? <p class="gsv-inline-error">{runtime.error}</p> : null}
      {!runtime.loading && runtime.notice ? <p class="gsv-inline-status">{runtime.notice}</p> : null}

      <div class="gsv-adapter-list" aria-label="Message adapters">
        {ADAPTERS.map((adapter) => {
          const accounts = runtime.state.statusByAdapter[adapter.id] ?? [];
          return (
            <button
              key={adapter.id}
              type="button"
              class={`gsv-adapter-row${runtime.selectedAdapter === adapter.id ? " is-selected" : ""}`}
              onClick={() => runtime.selectAdapter(adapter.id)}
            >
              <span class="gsv-adapter-icon">{adapter.shortName}</span>
              <span class="gsv-row-copy">
                <strong>{adapter.name}</strong>
                <span>{adapter.summary}</span>
              </span>
              <span class={`gsv-adapter-dot ${getAdapterTone(accounts)}`} aria-hidden="true"></span>
            </button>
          );
        })}
      </div>

      <div class="gsv-account-strip" aria-label={`${runtime.adapterMeta.name} accounts`}>
        <button
          type="button"
          class={`gsv-account-chip${runtime.selectedAccount === "new" ? " is-selected" : ""}`}
          onClick={() => runtime.selectAccount("new")}
        >
          <span>+</span>
          New
        </button>
        {runtime.accounts.map((account) => (
          <button
            key={account.accountId}
            type="button"
            class={`gsv-account-chip${runtime.selectedAccount === account.accountId ? " is-selected" : ""}`}
            onClick={() => runtime.selectAccount(account.accountId)}
          >
            <span class={`gsv-adapter-dot ${getAccountTone(account)}`} aria-hidden="true"></span>
            {account.accountId}
          </button>
        ))}
      </div>

      {!runtime.loading ? (
        runtime.currentAccount ? (
          <ConnectedAccountPanel
            adapter={runtime.selectedAdapter}
            account={runtime.currentAccount}
            challenge={runtime.visibleChallenge}
          />
        ) : (
          <ConnectAccountPanel runtime={runtime} />
        )
      ) : null}
    </section>
  );
}

function ConnectedAccountPanel({
  adapter,
  account,
  challenge,
}: {
  adapter: AdapterKind;
  account: AdapterAccount;
  challenge: AdapterConnectChallenge | null;
}) {
  return (
    <div class="gsv-integration-body">
      <section class="gsv-integration-panel">
        <header>
          <h4>Connection</h4>
          <p>Last known health and account state from the adapter worker.</p>
        </header>
        <div class="gsv-summary-grid">
          <article class="gsv-info-box">
            <span>Status</span>
            <strong>{getAccountStatus(account)}</strong>
          </article>
          <article class="gsv-info-box">
            <span>Authentication</span>
            <strong>{account.authenticated ? "Authenticated" : "Needs attention"}</strong>
          </article>
          <article class="gsv-info-box">
            <span>Mode</span>
            <strong>{account.mode || "Unknown"}</strong>
          </article>
          <article class="gsv-info-box">
            <span>Last activity</span>
            <strong>{formatTimestampMs(account.lastActivity)}</strong>
          </article>
        </div>
        {account.error ? <p class="gsv-inline-error">{account.error}</p> : null}
      </section>

      <section class="gsv-integration-panel">
        <header>
          <h4>Identity</h4>
          <p>Account details GSV currently knows for this adapter session.</p>
        </header>
        <dl class="gsv-detail-list">
          {describeAccount(adapter, account).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {challenge ? <ChallengePanel adapter={adapter} challenge={challenge} /> : null}
    </div>
  );
}

function ConnectAccountPanel({ runtime }: { runtime: ReturnType<typeof useMessageAdapters> }) {
  return (
    <div class="gsv-integration-body">
      <section class="gsv-integration-panel">
        <header>
          <h4>Connect {runtime.adapterMeta.name}</h4>
          <p>{runtime.adapterMeta.detail}</p>
        </header>
        <form class="gsv-integration-form" onSubmit={(event) => void runtime.submitConnect(event)}>
          <label>
            <span>Name</span>
            {runtime.selectedAdapter === "whatsapp" ? (
              <input
                type="text"
                value={runtime.whatsappName}
                onInput={(event) => runtime.setWhatsappName((event.currentTarget as HTMLInputElement).value)}
                placeholder={runtime.adapterMeta.accountPlaceholder}
                required
              />
            ) : (
              <input
                type="text"
                value={runtime.discordName}
                onInput={(event) => runtime.setDiscordName((event.currentTarget as HTMLInputElement).value)}
                placeholder={runtime.adapterMeta.accountPlaceholder}
                required
              />
            )}
          </label>

          {runtime.selectedAdapter === "whatsapp" ? (
            <label class="gsv-check-row">
              <input
                type="checkbox"
                checked={runtime.whatsappForce}
                onChange={(event) => runtime.setWhatsappForce((event.currentTarget as HTMLInputElement).checked)}
              />
              <span>Force a fresh QR session</span>
            </label>
          ) : (
            <label>
              <span>Bot token</span>
              <input
                type="password"
                value={runtime.discordToken}
                onInput={(event) => runtime.setDiscordToken((event.currentTarget as HTMLInputElement).value)}
                placeholder="Leave blank to use the deployment default"
              />
            </label>
          )}

          <ActionButton
            icon="plug"
            label={runtime.selectedAdapter === "whatsapp" ? "Pair" : "Connect"}
            busyLabel="Connecting"
            busy={runtime.busy}
            type="submit"
          />
        </form>
      </section>

      {runtime.visibleChallenge ? (
        <ChallengePanel adapter={runtime.selectedAdapter} challenge={runtime.visibleChallenge} />
      ) : null}
    </div>
  );
}

function ChallengePanel({ adapter, challenge }: { adapter: AdapterKind; challenge: AdapterConnectChallenge }) {
  return (
    <section class="gsv-integration-panel">
      <header>
        <h4>{challenge.type === "qr" ? "Pair device" : "Next step"}</h4>
        <p>{challenge.message || `Complete the ${adapter} authentication flow, then refresh status.`}</p>
      </header>
      {challenge.type === "qr" && challenge.data ? (
        <div class="gsv-challenge-layout">
          <QrChallengeGraphic value={challenge.data} />
          <div class="gsv-challenge-copy">
            <strong>Pairing instructions</strong>
            <ol>
              <li>Open the app on your phone.</li>
              <li>Open linked devices.</li>
              <li>Scan the QR code shown here.</li>
            </ol>
          </div>
        </div>
      ) : null}
      {challenge.type !== "qr" && challenge.data ? <pre class="gsv-challenge-code">{challenge.data}</pre> : null}
      {challenge.expiresAt ? <p class="gsv-runtime-meta">Expires {formatTimestampMs(challenge.expiresAt)}</p> : null}
    </section>
  );
}

function QrChallengeGraphic(props: { value: string }) {
  const graphic = useMemo(() => createQrChallengeGraphic(props.value), [props.value]);
  if (graphic.kind === "image") {
    return (
      <div class="gsv-challenge-graphic" aria-label="QR code">
        <img src={graphic.src} alt="QR code" />
      </div>
    );
  }
  if (graphic.kind === "svg") {
    return (
      <div
        class="gsv-challenge-graphic"
        aria-label="QR code"
        dangerouslySetInnerHTML={{ __html: graphic.markup }}
      />
    );
  }
  return <pre class="gsv-challenge-code">{props.value}</pre>;
}

function countConnectedAccounts(statusByAdapter: Record<AdapterKind, AdapterAccount[]>): number {
  return Object.values(statusByAdapter).reduce(
    (count, accounts) => count + accounts.filter((account) => account.connected).length,
    0,
  );
}

function readIntegrationKindFromLocation(): IntegrationKind | null {
  const value = new URL(window.location.href).searchParams.get("type");
  if (value === "mcp-servers") return "mcp-servers";
  if (value === "message-adapters") return "message-adapters";
  return null;
}

function createQrChallengeGraphic(value: string):
  | { kind: "image"; src: string }
  | { kind: "svg"; markup: string }
  | { kind: "raw" } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { kind: "raw" };
  }
  if (/^data:image\//i.test(trimmed)) {
    return { kind: "image", src: trimmed };
  }
  try {
    const code = qrcode(0, "M");
    code.addData(trimmed);
    code.make();
    return {
      kind: "svg",
      markup: code.createSvgTag({
        cellSize: 6,
        margin: 0,
        scalable: true,
      }),
    };
  } catch {
    return { kind: "raw" };
  }
}
