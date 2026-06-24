import { ConsoleDetailPage } from "../components/ConsoleDetailPage";
import type { ConsoleAdapterAccount } from "../domain/consoleModels";
import {
  adapterDetailSections,
  adapterLabel,
  adapterSub,
  iconForAdapterName,
  statusForAdapter,
  toneForAdapter,
} from "./messengerPresentation";

type MessengerDetailPageProps = {
  adapter: ConsoleAdapterAccount;
  onReconnect?: (adapter: ConsoleAdapterAccount) => void;
  onBack: () => void;
};

export function MessengerDetailPage({ adapter, onBack, onReconnect }: MessengerDetailPageProps) {
  return (
    <ConsoleDetailPage
      icon={iconForAdapterName(adapter.adapter)}
      title={adapterLabel(adapter)}
      typeLabel="GSV · MESSENGER"
      statusLabel={statusForAdapter(adapter)}
      tone={toneForAdapter(adapter)}
      blurb={adapter.error || adapterSub(adapter)}
      parentLabel="MESSENGERS"
      primaryLabel="RECONNECT"
      onPrimary={onReconnect ? () => onReconnect(adapter) : undefined}
      sections={adapterDetailSections(adapter)}
      onBack={onBack}
    />
  );
}
