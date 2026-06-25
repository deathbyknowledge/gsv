import { useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { Icon } from "../../../components/ui/Icon";
import { ListRow, type ListRowStatus } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { Tag, type TagTone } from "../../../components/ui/Tag";
import { Tooltip } from "../../../components/ui/Tooltip";
import { listRowStatusForTone } from "../components/consoleDetailRows";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import {
  NEW_DETAIL_ID,
  type ConsoleListSelection,
} from "../domain/consoleListTypes";
import type {
  ConsoleAccount,
  ConsoleAdapter,
  ConsoleAdapterAccount,
  ConsoleIdentityLink,
  ConsoleResourceState,
} from "../domain/consoleModels";
import {
  useConsoleAccounts,
  useConsoleAdapterInventory,
  useConsoleIdentityLinks,
} from "../hooks/useConsoleData";
import { useConsoleListSelection } from "../hooks/useConsoleListSelection";
import { MessengerDetailPage } from "./MessengerDetailPage";
import { linksForMessengerAccount } from "./MessengerIdentityLinks";
import { MessengerLinkCodePanel } from "./MessengerLinkCodePanel";
import { MessengerOnboardingFlow } from "./MessengerOnboardingFlow";
import {
  SUPPORTED_MESSENGER_ADAPTERS,
  adapterDetailId,
  adapterLabel,
  adapterName,
  adapterSub,
  familyStatus,
  iconForAdapterName,
  parseAdapterDetailId,
  statusForAdapter,
  toneForAdapter,
} from "./messengerPresentation";
import "./MessengersPage.css";

type MessengersPageProps = {
  initialCreate?: boolean;
  initialDetailId?: string | null;
  initialDetailLabel?: string | null;
  onSelectionChange?: (selection: ConsoleListSelection | null) => void;
};

const PLATFORM_BLURB: Record<string, string> = {
  telegram: "Message your GSV from Telegram — check files, approve tasks, and stay in control from anywhere.",
  discord: "Bring your GSV into Discord — check files, approve tasks, and stay in control from anywhere.",
};

function platformBlurb(adapter: string): string {
  return PLATFORM_BLURB[adapter] ?? `Connect ${adapterName(adapter)} to message your GSV remotely.`;
}

function placeholderAdapter(adapter: string): ConsoleAdapter {
  return {
    adapter,
    available: false,
    supportsConnect: true,
    supportsDisconnect: false,
    supportsSend: false,
    supportsStatus: false,
    supportsShellExec: false,
    supportsActivity: false,
    accounts: [],
  };
}

function supportedAdapters(inventory: readonly ConsoleAdapter[]): ConsoleAdapter[] {
  return SUPPORTED_MESSENGER_ADAPTERS.map(
    (id) => inventory.find((entry) => entry.adapter === id) ?? placeholderAdapter(id),
  );
}

function resourceWithLocalEmptyState<T>(resource: ConsoleResourceState<T>): ConsoleResourceState<T> {
  return { ...resource, isEmpty: false };
}

function linkedIdentityCountLabel(count: number): string {
  if (count === 0) {
    return "";
  }
  return `${count} linked ${count === 1 ? "identity" : "identities"}`;
}

function accountSub(account: ConsoleAdapterAccount, identityLinks: readonly ConsoleIdentityLink[]): string {
  return [
    adapterSub(account),
    linkedIdentityCountLabel(linksForMessengerAccount(account, identityLinks).length),
  ].filter(Boolean).join(" / ");
}

function PlatformStatusBadge({ adapter }: { adapter: ConsoleAdapter }) {
  const info = familyStatus(adapter);
  const badge = <Tag tone={info.tone as TagTone} label={info.label} dot boxed />;
  return info.tooltip ? (
    <Tooltip text={info.tooltip} position="top">{badge}</Tooltip>
  ) : badge;
}

function MessengerCard({
  adapter,
  identityLinks,
  onConnect,
  onOpenDetail,
}: {
  adapter: ConsoleAdapter;
  identityLinks: readonly ConsoleIdentityLink[];
  onConnect: (adapter: ConsoleAdapter) => void;
  onOpenDetail: (account: ConsoleAdapterAccount) => void;
}) {
  const platform = adapterName(adapter.adapter).toUpperCase();
  const bots = adapter.accounts;

  return (
    <article class="gsv-messenger-card">
      <header class="gsv-messenger-card-head">
        <span class="gsv-messenger-card-glyph">
          <Icon name={iconForAdapterName(adapter.adapter)} size={26} />
        </span>
        <div class="gsv-messenger-card-heading">
          <span class="gsv-messenger-card-name">{platform}</span>
          <PlatformStatusBadge adapter={adapter} />
        </div>
      </header>

      <div class="gsv-messenger-card-body">
        <p class="gsv-messenger-card-blurb">{platformBlurb(adapter.adapter)}</p>

        {bots.length > 0 ? (
          <div class="gsv-messenger-card-bots">
            <div class="gsv-messenger-card-bots-label">
              {bots.length} {bots.length === 1 ? "BOT" : "BOTS"}
            </div>
            {bots.map((account) => (
              <ListRow
                key={adapterDetailId(account)}
                icon={iconForAdapterName(account.adapter)}
                label={adapterLabel(account)}
                sub={accountSub(account, identityLinks)}
                status={listRowStatusForTone(toneForAdapter(account)) as ListRowStatus}
                statusDotPlacement="trailing"
                statusLabel={statusForAdapter(account)}
                chevron
                onClick={() => onOpenDetail(account)}
              />
            ))}
          </div>
        ) : (
          <div class="gsv-messenger-card-hint">No bot connected yet.</div>
        )}
      </div>

      <footer class="gsv-messenger-card-foot">
        <Button
          variant={bots.length > 0 ? "secondary" : "primary"}
          block
          label={bots.length > 0 ? `CONNECT ANOTHER ${platform}` : `CONNECT ${platform}`}
          onClick={() => onConnect(adapter)}
        />
      </footer>
    </article>
  );
}

function MessengersRoster({
  adapters,
  identityLinks,
  identityLinksError,
  identityLinksRefreshing,
  onConnect,
  onOpenDetail,
  refreshing,
}: {
  adapters: readonly ConsoleAdapter[];
  identityLinks: readonly ConsoleIdentityLink[];
  identityLinksError?: string;
  identityLinksRefreshing: boolean;
  onConnect: (adapter: ConsoleAdapter) => void;
  onOpenDetail: (account: ConsoleAdapterAccount) => void;
  refreshing: boolean;
}) {
  const platforms = supportedAdapters(adapters);
  const connected = platforms.filter((adapter) => familyStatus(adapter).status === "connected").length;
  const meta = refreshing
    ? "REFRESHING"
    : `${platforms.length} SERVICES / ${connected} CONNECTED`;

  return (
    <section class="gsv-messengers">
      <div class="gsv-messengers-panel">
        <SectionHeader title="MESSENGERS" meta={meta} divider />
        <div class="gsv-messengers-link-code">
          <MessengerLinkCodePanel
            errorText={identityLinksError}
            linkCount={identityLinks.length}
            refreshing={identityLinksRefreshing}
          />
        </div>
        <div class="gsv-messengers-grid">
          {platforms.map((adapter) => (
            <MessengerCard
              key={adapter.adapter}
              adapter={adapter}
              identityLinks={identityLinks}
              onConnect={onConnect}
              onOpenDetail={onOpenDetail}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function renderMessengerDetail(
  accounts: readonly ConsoleAccount[],
  adapters: readonly ConsoleAdapter[],
  identityLinks: readonly ConsoleIdentityLink[],
  identityLinksError: string | undefined,
  identityLinksRefreshing: boolean,
  id: string,
  onBack: () => void,
  onReconnect: (account: ConsoleAdapterAccount) => void,
) {
  const parsed = parseAdapterDetailId(id);
  const account = parsed
    ? adapters
      .find((entry) => entry.adapter === parsed.adapter)
      ?.accounts.find((entry) => entry.accountId === parsed.accountId) ?? null
    : null;
  return account ? (
    <MessengerDetailPage
      accounts={accounts}
      adapter={account}
      identityLinks={linksForMessengerAccount(account, identityLinks)}
      identityLinksError={identityLinksError}
      identityLinksRefreshing={identityLinksRefreshing}
      onBack={onBack}
      onReconnect={onReconnect}
    />
  ) : null;
}

export function MessengersPage({
  initialCreate = false,
  initialDetailId = null,
  initialDetailLabel = null,
  onSelectionChange,
}: MessengersPageProps) {
  const adapters = useConsoleAdapterInventory({ enabled: true });
  const accounts = useConsoleAccounts({ enabled: true });
  const identityLinks = useConsoleIdentityLinks({ enabled: true });
  const [preferredAdapter, setPreferredAdapter] = useState<string | null>(null);
  const { selectedDetail, selectDetail } = useConsoleListSelection({
    initialCreate,
    initialDetailId,
    initialDetailLabel,
    kind: "messengers",
    onSelectionChange,
  });

  const openCreate = (adapter: ConsoleAdapter) => {
    setPreferredAdapter(adapter.adapter);
    selectDetail({ kind: "messengers", id: NEW_DETAIL_ID, createNew: true, label: `New ${adapterName(adapter.adapter)}` });
  };

  const openDetail = (account: ConsoleAdapterAccount) =>
    selectDetail({ kind: "messengers", id: adapterDetailId(account), label: `${adapterName(account.adapter)} · ${adapterLabel(account)}` });

  const reconnect = (account: ConsoleAdapterAccount) => {
    setPreferredAdapter(account.adapter);
    selectDetail({ kind: "messengers", id: NEW_DETAIL_ID, createNew: true, label: `Reconnect ${adapterName(account.adapter)}` });
  };

  return (
    <ConsolePage flush>
      <ConsoleResourceBoundary
        resource={resourceWithLocalEmptyState(adapters.resource)}
        emptyLabel="NO MESSENGERS"
        errorLabel="MESSENGERS"
        render={(data) => {
          const identityLinksError = identityLinks.resource.isError ? identityLinks.resource.errorText : undefined;
          const identityLinksRefreshing = identityLinks.resource.isLoading || identityLinks.resource.isRefreshing;

          if (selectedDetail?.kind === "messengers" && selectedDetail.createNew) {
            return (
              <MessengerOnboardingFlow
                adapterId={preferredAdapter ?? "telegram"}
                onBack={() => selectDetail(null)}
                onConnected={(id) => selectDetail({ kind: "messengers", id })}
              />
            );
          }

          if (selectedDetail?.kind === "messengers" && selectedDetail.id !== NEW_DETAIL_ID) {
            const platform = SUPPORTED_MESSENGER_ADAPTERS.find((id) => id === selectedDetail.id);
            if (platform) {
              const target = supportedAdapters(data).find((entry) => entry.adapter === platform);
              if (target && target.accounts.length === 0) {
                return (
                  <MessengerOnboardingFlow
                    adapterId={platform}
                    onBack={() => selectDetail(null)}
                    onConnected={(id) => selectDetail({ kind: "messengers", id })}
                  />
                );
              }
            }

            const detail = renderMessengerDetail(
              accounts.accounts,
              data,
              identityLinks.links,
              identityLinksError,
              identityLinksRefreshing,
              selectedDetail.id,
              () => selectDetail(null),
              reconnect,
            );
            if (detail) {
              return detail;
            }
          }

          return (
            <MessengersRoster
              adapters={data}
              identityLinks={identityLinks.links}
              identityLinksError={identityLinksError}
              identityLinksRefreshing={identityLinksRefreshing}
              onConnect={openCreate}
              onOpenDetail={openDetail}
              refreshing={adapters.resource.isRefreshing}
            />
          );
        }}
      />
    </ConsolePage>
  );
}
