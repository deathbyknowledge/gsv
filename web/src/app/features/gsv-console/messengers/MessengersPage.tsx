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
import type { ConsoleAdapter, ConsoleAdapterAccount, ConsoleResourceState } from "../domain/consoleModels";
import { useConsoleAdapterInventory } from "../hooks/useConsoleData";
import { useConsoleListSelection } from "../hooks/useConsoleListSelection";
import { MessengerDetailPage } from "./MessengerDetailPage";
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

function accountRows(adapter: ConsoleAdapter, onOpenDetail: (account: ConsoleAdapterAccount) => void) {
  return adapter.accounts.map((account) => ({
    id: adapterDetailId(account),
    icon: iconForAdapterName(account.adapter),
    label: adapterLabel(account),
    sub: adapterSub(account),
    tone: toneForAdapter(account),
    statusLabel: statusForAdapter(account),
    onOpen: () => onOpenDetail(account),
  }));
}

function MessengersConsoleSections({
  adapters,
  onOpenCreate,
  onOpenDetail,
  refreshing,
}: {
  adapters: readonly ConsoleAdapter[];
  onOpenCreate: (adapter: ConsoleAdapter) => void;
  onOpenDetail: (adapter: ConsoleAdapterAccount) => void;
  refreshing: boolean;
}) {
  return (
    <>
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
            rows={accountRows(adapter, onOpenDetail)}
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
  adapters: readonly ConsoleAdapter[],
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
  return account ? <MessengerDetailPage adapter={account} onBack={onBack} onReconnect={onReconnect} /> : null;
}

export function MessengersPage({
  initialCreate = false,
  initialDetailId = null,
  initialDetailLabel = null,
  onSelectionChange,
}: MessengersPageProps) {
  const adapters = useConsoleAdapterInventory({ enabled: true });
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
        render={(data) => (
          selectedDetail?.kind === "messengers" && selectedDetail.createNew ? (
            <MessengerOnboardingFlow
              adapters={data}
              initialAccountId={preferredAccount}
              initialAdapter={preferredAdapter}
              onBack={() => selectDetail(null)}
              onConnected={(id) => selectDetail({ kind: "messengers", id })}
            />
          ) : selectedDetail?.kind === "messengers" && selectedDetail.id !== NEW_DETAIL_ID
            ? renderMessengerDetail(data, selectedDetail.id, () => selectDetail(null), (account) => {
              setPreferredAdapter(account.adapter);
              setPreferredAccount(account.accountId);
              selectDetail({ kind: "messengers", id: NEW_DETAIL_ID, createNew: true, label: `Reconnect ${adapterName(account.adapter)} · ${account.accountId}` });
            }) ?? (
              <MessengersConsoleSections
                adapters={data}
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
                onOpenCreate={(adapter) => {
                  setPreferredAdapter(adapter.adapter);
                  setPreferredAccount(null);
                  selectDetail({ kind: "messengers", id: NEW_DETAIL_ID, createNew: true, label: `New ${adapterName(adapter.adapter)}` });
                }}
                onOpenDetail={(adapter) => selectDetail({ kind: "messengers", id: adapterDetailId(adapter), label: `${adapterName(adapter.adapter)} · ${adapterLabel(adapter)}` })}
                refreshing={adapters.resource.isRefreshing}
              />
            )
        )}
      />
    </ConsolePage>
  );
}
