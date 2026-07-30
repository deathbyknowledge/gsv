import { useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { Icon } from "../../../components/ui/Icon";
import { Link } from "../../../components/ui/Link";
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
import { adapterDocUrl } from "./messengerDocs";
import {
  SUPPORTED_MESSENGER_ADAPTERS,
  adapterDetailId,
  adapterLabel,
  adapterName,
  adapterSub,
  familyStatus,
  iconForAdapterName,
  messengerAccountNoun,
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
  whatsapp: "Message your GSV through a dedicated WhatsApp account linked with a QR code.",
};

function platformBlurb(adapter: string): string {
  return PLATFORM_BLURB[adapter] ?? `Connect ${adapterName(adapter)} to message your GSV remotely.`;
}

function placeholderAdapter(adapter: string): ConsoleAdapter {
  return {
    adapter,
    available: false,
    supportsConnect: false,
    supportsDisconnect: false,
    supportsSend: false,
    supportsStatus: false,
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

const MAX_CARD_ACCOUNTS = 2;

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
  const accounts = adapter.accounts;
  const visible = accounts.slice(0, MAX_CARD_ACCOUNTS);
  const extra = accounts.length - visible.length;
  const accountNoun = messengerAccountNoun(adapter.adapter, accounts.length);
  const canConnect = adapter.available && adapter.supportsConnect;

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

        {accounts.length > 0 ? (
          <div class="gsv-messenger-card-bots">
            <div class="gsv-messenger-card-bots-label gsv-sublabel">
              {accounts.length} {accountNoun.toUpperCase()}
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
          <div class="gsv-messenger-card-hint gsv-label">
            {adapter.available
              ? `No ${messengerAccountNoun(adapter.adapter)} connected yet.`
              : `The ${adapterName(adapter.adapter)} adapter worker is not deployed.`}
          </div>
        )}
        {!adapter.available ? (
          <p class="gsv-messenger-card-deploy gsv-prose-sm">
            Deploy the channel-{adapter.adapter} component, then refresh this page. {" "}
            <Link href={adapterDocUrl(adapter.adapter)} arrow>Deployment guide</Link>
          </p>
        ) : null}
      </div>

      <footer class="gsv-messenger-card-foot">
        <Button
          variant={accounts.length > 0 ? "secondary" : "primary"}
          block
          label={!canConnect
            ? `${platform} UNAVAILABLE`
            : accounts.length > 0
              ? `CONNECT ANOTHER ${platform}`
              : `CONNECT ${platform}`}
          disabled={!canConnect}
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

/** Dedicated per-platform page listing every account for one messenger — opened
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
  const accountNoun = messengerAccountNoun(adapter.adapter, total);
  const canConnect = adapter.available && adapter.supportsConnect;

  return (
    <ConsoleDetailPage
      icon={iconForAdapterName(adapter.adapter)}
      title={adapterName(adapter.adapter)}
      typeLabel="GSV · MESSENGER"
      statusLabel={info.label}
      tone={info.tone}
      blurb={adapter.available
        ? `${info.connectedCount} of ${total} ${accountNoun} connected.`
        : `${adapterName(adapter.adapter)} adapter worker unavailable. Deploy channel-${adapter.adapter} to connect it.`}
      parentLabel="MESSENGERS"
      primaryLabel={canConnect ? `CONNECT ANOTHER ${platform}` : `${platform} UNAVAILABLE`}
      onPrimary={canConnect ? () => onConnect(adapter) : undefined}
      onBack={onBack}
    >
      <section class="gsv-messenger-platform">
        <SectionHeader title={accountNoun.toUpperCase()} meta={String(total)} divider />
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
  onRelink: (account: ConsoleAdapterAccount) => void,
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
      onRelink={onRelink}
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
  const [onboarding, setOnboarding] = useState<{
    adapterId: string;
    accountId: string | null;
    forceRelink: boolean;
  } | null>(null);
  const { selectedDetail, selectDetail } = useConsoleListSelection({
    initialCreate,
    initialDetailId,
    initialDetailLabel,
    kind: "messengers",
    onSelectionChange,
  });

  const openCreate = (adapter: ConsoleAdapter) => {
    if (!adapter.available || !adapter.supportsConnect) {
      return;
    }
    setOnboarding({ adapterId: adapter.adapter, accountId: null, forceRelink: false });
    selectDetail({ kind: "messengers", id: NEW_DETAIL_ID, createNew: true, label: `New ${adapterName(adapter.adapter)}` });
  };

  const openDetail = (account: ConsoleAdapterAccount) =>
    selectDetail({ kind: "messengers", id: adapterDetailId(account), label: `${adapterName(account.adapter)} · ${adapterLabel(account)}` });

  const openPlatform = (adapter: ConsoleAdapter) =>
    selectDetail({
      kind: "messengers",
      id: adapter.adapter,
      label: `${adapterName(adapter.adapter)} · all ${messengerAccountNoun(adapter.adapter, 2)}`,
    });

  const reconnect = (account: ConsoleAdapterAccount) => {
    setOnboarding({ adapterId: account.adapter, accountId: account.accountId, forceRelink: false });
    selectDetail({ kind: "messengers", id: NEW_DETAIL_ID, createNew: true, label: `Reconnect ${adapterName(account.adapter)}` });
  };

  const relink = (account: ConsoleAdapterAccount) => {
    setOnboarding({ adapterId: account.adapter, accountId: account.accountId, forceRelink: true });
    selectDetail({ kind: "messengers", id: NEW_DETAIL_ID, createNew: true, label: `Relink ${adapterName(account.adapter)}` });
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
                adapterId={onboarding?.adapterId ?? "telegram"}
                existingAccountIds={data
                  .find((entry) => entry.adapter === (onboarding?.adapterId ?? "telegram"))
                  ?.accounts.map((account) => account.accountId) ?? []}
                forceRelink={onboarding?.forceRelink ?? false}
                initialAccountId={onboarding?.accountId ?? null}
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
                // No accounts yet → straight to the connect flow; otherwise the
                // dedicated full-list page for the platform.
                if (target.accounts.length === 0 && target.available && target.supportsConnect) {
                  return (
                    <MessengerOnboardingFlow
                      adapterId={platform}
                      existingAccountIds={[]}
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
              relink,
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
