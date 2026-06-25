import { ConsoleDetailPage } from "../components/ConsoleDetailPage";
import type {
  ConsoleAccount,
  ConsoleAdapterAccount,
  ConsoleIdentityLink,
} from "../domain/consoleModels";
import { MessengerIdentityLinks } from "./MessengerIdentityLinks";
import {
  adapterDetailSections,
  adapterLabel,
  adapterSub,
  iconForAdapterName,
  statusForAdapter,
  toneForAdapter,
} from "./messengerPresentation";

type MessengerDetailPageProps = {
  accounts: readonly ConsoleAccount[];
  adapter: ConsoleAdapterAccount;
  identityLinks: readonly ConsoleIdentityLink[];
  identityLinksError?: string;
  identityLinksRefreshing: boolean;
  onReconnect?: (adapter: ConsoleAdapterAccount) => void;
  onBack: () => void;
};

export function MessengerDetailPage({
  accounts,
  adapter,
  identityLinks,
  identityLinksError,
  identityLinksRefreshing,
  onBack,
  onReconnect,
}: MessengerDetailPageProps) {
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
    >
      <MessengerIdentityLinks
        accounts={accounts}
        errorText={identityLinksError}
        links={identityLinks}
        messenger={adapter}
        refreshing={identityLinksRefreshing}
      />
    </ConsoleDetailPage>
  );
}
