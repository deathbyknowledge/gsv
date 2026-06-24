import { SettingsListPanel } from "../components/SettingsListPanel";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import type { ConsoleListSelection } from "../domain/consoleListTypes";
import type { ConsoleAdapterAccount, ConsoleResourceState } from "../domain/consoleModels";
import { useConsoleAdapters } from "../hooks/useConsoleData";
import { useConsoleListSelection } from "../hooks/useConsoleListSelection";
import { MessengerDetailPage } from "./MessengerDetailPage";
import {
  adapterDetailId,
  adapterLabel,
  adapterSub,
  iconForAdapterName,
  statusForAdapter,
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

function MessengersConsoleSection({
  adapters,
  onOpenDetail,
  refreshing,
}: {
  adapters: readonly ConsoleAdapterAccount[];
  onOpenDetail: (adapter: ConsoleAdapterAccount) => void;
  refreshing: boolean;
}) {
  const connected = adapters.filter((adapter) => adapter.connected && adapter.authenticated && !adapter.error);

  return (
    <SettingsListPanel
      title="MESSENGERS"
      meta={refreshing ? "REFRESHING" : `${connected.length}/${adapters.length} CONNECTED`}
      emptyLabel="NO MESSENGERS"
      rows={adapters.map((adapter) => ({
        id: adapterDetailId(adapter),
        icon: iconForAdapterName(adapter.adapter),
        label: adapterLabel(adapter),
        sub: adapterSub(adapter),
        tone: toneForAdapter(adapter),
        statusLabel: statusForAdapter(adapter),
        onOpen: () => onOpenDetail(adapter),
      }))}
    />
  );
}

function renderMessengerDetail(
  adapters: readonly ConsoleAdapterAccount[],
  id: string,
  onBack: () => void,
) {
  const adapter = adapters.find((entry) => adapterDetailId(entry) === id);
  return adapter ? <MessengerDetailPage adapter={adapter} onBack={onBack} /> : null;
}

export function MessengersPage({
  initialCreate = false,
  initialDetailId = null,
  initialDetailLabel = null,
  onSelectionChange,
}: MessengersPageProps) {
  const adapters = useConsoleAdapters({ enabled: true });
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
          selectedDetail?.kind === "messengers"
            ? renderMessengerDetail(data, selectedDetail.id, () => selectDetail(null)) ?? (
              <MessengersConsoleSection
                adapters={data}
                onOpenDetail={(adapter) => selectDetail({ kind: "messengers", id: adapterDetailId(adapter), label: adapterLabel(adapter) })}
                refreshing={adapters.resource.isRefreshing}
              />
            )
            : (
              <MessengersConsoleSection
                adapters={data}
                onOpenDetail={(adapter) => selectDetail({ kind: "messengers", id: adapterDetailId(adapter), label: adapterLabel(adapter) })}
                refreshing={adapters.resource.isRefreshing}
              />
            )
        )}
      />
    </ConsolePage>
  );
}
