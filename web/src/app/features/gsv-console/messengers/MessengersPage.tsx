import { useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { Icon } from "../../../components/ui/Icon";
import { ListRow, type ListRowStatus } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import { CardListTemplate } from "../card-template/CardListTemplate";
import { Tag, type TagTone } from "../../../components/ui/Tag";
import { Tooltip } from "../../../components/ui/Tooltip";
import { listRowStatusForTone } from "../components/consoleDetailRows";
import { ConsoleDetailPage } from "../components/ConsoleDetailPage";
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
  useDisconnectConsoleAdapter,
} from "../hooks/useConsoleData";
import { useConsoleListSelection } from "../hooks/useConsoleListSelection";
import { MessengerDetailPage } from "./MessengerDetailPage";
import { linksForMessengerAccount } from "./MessengerIdentityLinks";
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

const MAX_CARD_BOTS = 2;

export function MessengerCard({
  adapter,
  identityLinks,
  onConnect,
  onOpenDetail,
  onOpenPlatform,
}: {
  adapter: ConsoleAdapter;
  identityLinks: readonly ConsoleIdentityLink[];
  onConnect: (adapter: ConsoleAdapter) => void;
  onOpenDetail: (account: ConsoleAdapterAccount) => void;
  onOpenPlatform: (adapter: ConsoleAdapter) => void;
}) {
  const platform = adapterName(adapter.adapter).toUpperCase();
  const bots = adapter.accounts;
  const visible = bots.slice(0, MAX_CARD_BOTS);
  const extra = bots.length - visible.length;

  return (
    <article class="gsv-messenger-card">
      <header class="gsv-messenger-card-head">
        <span class="gsv-messenger-card-glyph">
          <Icon name={iconForAdapterName(adapter.adapter)} size={26} />
        </span>
        <div class="gsv-messenger-card-heading">
          <span class="gsv-messenger-card-name gsv-section">{platform}</span>
          <PlatformStatusBadge adapter={adapter} />
        </div>
      </header>

      <div class="gsv-messenger-card-body">
        <p class="gsv-messenger-card-blurb gsv-prose-sm">{platformBlurb(adapter.adapter)}</p>

        {bots.length > 0 ? (
          <div class="gsv-messenger-card-bots">
            <div class="gsv-messenger-card-bots-label gsv-sublabel">
              {bots.length} {bots.length === 1 ? "BOT" : "BOTS"}
            </div>
            {visible.map((account) => (
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
            {extra > 0 ? (
              <button type="button" class="gsv-messenger-card-more gsv-label" onClick={() => onOpenPlatform(adapter)}>
                <span>{extra} more messenger{extra === 1 ? "" : "s"}</span>
                <span class="gsv-messenger-card-more-chevron" aria-hidden="true">›</span>
              </button>
            ) : null}
          </div>
        ) : (
          <div class="gsv-messenger-card-hint gsv-label">No bot connected yet.</div>
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
  onConnect,
  onOpenDetail,
  onOpenPlatform,
  refreshing,
}: {
  adapters: readonly ConsoleAdapter[];
  identityLinks: readonly ConsoleIdentityLink[];
  onConnect: (adapter: ConsoleAdapter) => void;
  onOpenDetail: (account: ConsoleAdapterAccount) => void;
  onOpenPlatform: (adapter: ConsoleAdapter) => void;
  refreshing: boolean;
}) {
  const platforms = supportedAdapters(adapters);
  const connected = platforms.filter((adapter) => familyStatus(adapter).status === "connected").length;
  const meta = refreshing
    ? "REFRESHING"
    : `${platforms.length} SERVICES / ${connected} CONNECTED`;

  return (
    <CardListTemplate
      listTitle="MESSENGERS"
      listMeta={meta}
      emptyObject="MESSENGERS"
      isEmpty={platforms.length === 0}
    >
      {platforms.map((adapter) => (
        <MessengerCard
          key={adapter.adapter}
          adapter={adapter}
          identityLinks={identityLinks}
          onConnect={onConnect}
          onOpenDetail={onOpenDetail}
          onOpenPlatform={onOpenPlatform}
        />
      ))}
    </CardListTemplate>
  );
}

/** Dedicated per-platform page listing every bot for one messenger — opened
 *  from a card's "N more messengers" affordance. Reuses the standard
 *  ConsoleDetailPage chrome (header + back + primary action). */
function MessengerPlatformPage({
  adapter,
  identityLinks,
  onBack,
  onConnect,
  onOpenDetail,
}: {
  adapter: ConsoleAdapter;
  identityLinks: readonly ConsoleIdentityLink[];
  onBack: () => void;
  onConnect: (adapter: ConsoleAdapter) => void;
  onOpenDetail: (account: ConsoleAdapterAccount) => void;
}) {
  const info = familyStatus(adapter);
  const platform = adapterName(adapter.adapter).toUpperCase();
  const total = adapter.accounts.length;

  return (
    <ConsoleDetailPage
      icon={iconForAdapterName(adapter.adapter)}
      title={adapterName(adapter.adapter)}
      typeLabel="GSV · MESSENGER"
      statusLabel={info.label}
      tone={info.tone}
      blurb={`${info.connectedCount} of ${total} ${total === 1 ? "bot" : "bots"} connected.`}
      parentLabel="MESSENGERS"
      primaryLabel={`CONNECT ANOTHER ${platform}`}
      onPrimary={() => onConnect(adapter)}
      onBack={onBack}
    >
      <section class="gsv-messenger-platform">
        <SectionHeader title="BOTS" meta={String(total)} divider />
        <div class="gsv-messenger-platform-rows">
          {adapter.accounts.map((account) => (
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
      </section>
    </ConsoleDetailPage>
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
  onDisconnect: (account: ConsoleAdapterAccount) => void,
  disconnecting: boolean,
  disconnectError: string | undefined,
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
      onDisconnect={onDisconnect}
      disconnecting={disconnecting}
      disconnectError={disconnectError}
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
  const disconnectAdapter = useDisconnectConsoleAdapter();
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

  const openPlatform = (adapter: ConsoleAdapter) =>
    selectDetail({ kind: "messengers", id: adapter.adapter, label: `${adapterName(adapter.adapter)} · all bots` });

  const reconnect = (account: ConsoleAdapterAccount) => {
    setPreferredAdapter(account.adapter);
    selectDetail({ kind: "messengers", id: NEW_DETAIL_ID, createNew: true, label: `Reconnect ${adapterName(account.adapter)}` });
  };

  const disconnect = (account: ConsoleAdapterAccount) => {
    void disconnectAdapter.mutateAsync({
      adapter: account.adapter,
      accountId: account.accountId,
    }).then(() => selectDetail(null));
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
              if (target) {
                // No bots yet → straight to the connect flow; otherwise the
                // dedicated full-list page for the platform.
                if (target.accounts.length === 0) {
                  return (
                    <MessengerOnboardingFlow
                      adapterId={platform}
                      onBack={() => selectDetail(null)}
                      onConnected={(id) => selectDetail({ kind: "messengers", id })}
                    />
                  );
                }
                return (
                  <MessengerPlatformPage
                    adapter={target}
                    identityLinks={identityLinks.links}
                    onBack={() => selectDetail(null)}
                    onConnect={openCreate}
                    onOpenDetail={openDetail}
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
              disconnect,
              disconnectAdapter.isPending,
              disconnectAdapter.error?.message,
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
              onConnect={openCreate}
              onOpenDetail={openDetail}
              onOpenPlatform={openPlatform}
              refreshing={adapters.resource.isRefreshing}
            />
          );
        }}
      />
    </ConsolePage>
  );
}
