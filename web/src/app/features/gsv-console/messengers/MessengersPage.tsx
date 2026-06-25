import { useState } from "preact/hooks";
import { SettingsListPanel } from "../components/SettingsListPanel";
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
import {
  linksForMessengerAccount,
} from "./MessengerIdentityLinks";
import { MessengerLinkCodePanel } from "./MessengerLinkCodePanel";
import { MessengerOnboardingFlow } from "./MessengerOnboardingFlow";
import {
  adapterDetailId,
  adapterLabel,
  adapterName,
  adapterSub,
  iconForAdapterName,
  parseAdapterDetailId,
  statusForAdapter,
  statusForAdapterFamily,
  toneForAdapter,
} from "./messengerPresentation";

type MessengersPageProps = {
  initialCreate?: boolean;
  initialDetailId?: string | null;
  initialDetailLabel?: string | null;
  onSelectionChange?: (selection: ConsoleListSelection | null) => void;
};

function resourceWithLocalEmptyState<T>(resource: ConsoleResourceState<T>): ConsoleResourceState<T> {
  return { ...resource, isEmpty: false };
}

function linkedIdentityCountLabel(count: number): string {
  if (count === 0) {
    return "";
  }
  return `${count} linked ${count === 1 ? "identity" : "identities"}`;
}

function accountRows(
  adapter: ConsoleAdapter,
  identityLinks: readonly ConsoleIdentityLink[],
  onOpenDetail: (account: ConsoleAdapterAccount) => void,
) {
  return adapter.accounts.map((account) => ({
    id: adapterDetailId(account),
    icon: iconForAdapterName(account.adapter),
    label: adapterLabel(account),
    sub: [
      adapterSub(account),
      linkedIdentityCountLabel(linksForMessengerAccount(account, identityLinks).length),
    ].filter(Boolean).join(" / "),
    tone: toneForAdapter(account),
    statusLabel: statusForAdapter(account),
    onOpen: () => onOpenDetail(account),
  }));
}

function MessengersConsoleSections({
  adapters,
  identityLinks,
  identityLinksError,
  identityLinksRefreshing,
  onOpenCreate,
  onOpenDetail,
  refreshing,
}: {
  adapters: readonly ConsoleAdapter[];
  identityLinks: readonly ConsoleIdentityLink[];
  identityLinksError?: string;
  identityLinksRefreshing: boolean;
  onOpenCreate: (adapter: ConsoleAdapter) => void;
  onOpenDetail: (adapter: ConsoleAdapterAccount) => void;
  refreshing: boolean;
}) {
  return (
    <>
      <MessengerLinkCodePanel
        errorText={identityLinksError}
        linkCount={identityLinks.length}
        refreshing={identityLinksRefreshing}
      />
      {adapters.length === 0 ? (
        <SettingsListPanel
          title="MESSENGERS"
          meta={refreshing ? "REFRESHING" : "0 ADAPTERS"}
          emptyLabel="NO ADAPTER WORKERS"
          rows={[]}
        />
      ) : adapters.map((adapter) => {
        const connected = adapter.accounts.filter((account) => account.connected && account.authenticated && !account.error).length;
        const meta = !adapter.available
          ? statusForAdapterFamily(adapter)
          : adapter.accounts.length === 0
            ? "READY"
            : `${connected}/${adapter.accounts.length} CONNECTED`;
        return (
          <SettingsListPanel
            key={adapter.adapter}
            fitContent
            title={adapterName(adapter.adapter).toUpperCase()}
            meta={refreshing ? "REFRESHING" : meta}
            emptyLabel={`NO ${adapterName(adapter.adapter).toUpperCase()} ACCOUNTS`}
            rows={accountRows(adapter, identityLinks, onOpenDetail)}
            action={adapter.available && adapter.supportsConnect
              ? { label: `CONNECT ${adapterName(adapter.adapter).toUpperCase()}`, onClick: () => onOpenCreate(adapter) }
              : adapter.available
                ? { label: "CONNECT UNSUPPORTED" }
                : { label: "ADAPTER UNAVAILABLE" }}
          />
        );
      })}
    </>
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
  const [preferredAccount, setPreferredAccount] = useState<string | null>(null);
  const { selectedDetail, selectDetail } = useConsoleListSelection({
    initialCreate,
    initialDetailId,
    initialDetailLabel,
    kind: "messengers",
    onSelectionChange,
  });

  return (
    <ConsolePage flush>
      <ConsoleResourceBoundary
        resource={resourceWithLocalEmptyState(adapters.resource)}
        emptyLabel="NO MESSENGERS"
        errorLabel="MESSENGERS"
        render={(data) => {
          const identityLinksError = identityLinks.resource.isError ? identityLinks.resource.errorText : undefined;
          const identityLinksRefreshing = identityLinks.resource.isLoading || identityLinks.resource.isRefreshing;
          return selectedDetail?.kind === "messengers" && selectedDetail.createNew ? (
            <MessengerOnboardingFlow
              adapters={data}
              initialAccountId={preferredAccount}
              initialAdapter={preferredAdapter}
              onBack={() => selectDetail(null)}
              onConnected={(id) => selectDetail({ kind: "messengers", id })}
            />
          ) : selectedDetail?.kind === "messengers" && selectedDetail.id !== NEW_DETAIL_ID
            ? renderMessengerDetail(accounts.accounts, data, identityLinks.links, identityLinksError, identityLinksRefreshing, selectedDetail.id, () => selectDetail(null), (account) => {
              setPreferredAdapter(account.adapter);
              setPreferredAccount(account.accountId);
              selectDetail({ kind: "messengers", id: NEW_DETAIL_ID, createNew: true, label: `Reconnect ${adapterName(account.adapter)} · ${account.accountId}` });
            }) ?? (
              <MessengersConsoleSections
                adapters={data}
                identityLinks={identityLinks.links}
                identityLinksError={identityLinksError}
                identityLinksRefreshing={identityLinksRefreshing}
                onOpenCreate={(adapter) => {
                  setPreferredAdapter(adapter.adapter);
                  setPreferredAccount(null);
                  selectDetail({ kind: "messengers", id: NEW_DETAIL_ID, createNew: true, label: `New ${adapterName(adapter.adapter)}` });
                }}
                onOpenDetail={(adapter) => selectDetail({ kind: "messengers", id: adapterDetailId(adapter), label: `${adapterName(adapter.adapter)} · ${adapterLabel(adapter)}` })}
                refreshing={adapters.resource.isRefreshing}
              />
            )
            : (
              <MessengersConsoleSections
                adapters={data}
                identityLinks={identityLinks.links}
                identityLinksError={identityLinksError}
                identityLinksRefreshing={identityLinksRefreshing}
                onOpenCreate={(adapter) => {
                  setPreferredAdapter(adapter.adapter);
                  setPreferredAccount(null);
                  selectDetail({ kind: "messengers", id: NEW_DETAIL_ID, createNew: true, label: `New ${adapterName(adapter.adapter)}` });
                }}
                onOpenDetail={(adapter) => selectDetail({ kind: "messengers", id: adapterDetailId(adapter), label: `${adapterName(adapter.adapter)} · ${adapterLabel(adapter)}` })}
                refreshing={adapters.resource.isRefreshing}
              />
            );
        }}
      />
    </ConsolePage>
  );
}
