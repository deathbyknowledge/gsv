import { useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { ConfirmModal } from "../../../components/ui/ConfirmModal";
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
  disconnectError?: string;
  disconnecting?: boolean;
  onDisconnect?: (adapter: ConsoleAdapterAccount) => void;
  onReconnect?: (adapter: ConsoleAdapterAccount) => void;
  onBack: () => void;
};

export function MessengerDetailPage({
  accounts,
  adapter,
  identityLinks,
  identityLinksError,
  identityLinksRefreshing,
  disconnectError,
  disconnecting = false,
  onBack,
  onDisconnect,
  onReconnect,
}: MessengerDetailPageProps) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const actionDisabled = disconnecting;

  return (
    <>
      <ConsoleDetailPage
        actions={(
          <div class="gsv-console-detail-actions">
            <Button
              variant="dangerGhost"
              label={disconnecting ? "DISCONNECTING" : "DISCONNECT BOT"}
              disabled={actionDisabled || !adapter.connected || !onDisconnect}
              onClick={() => setConfirmDisconnect(true)}
            />
            {disconnectError ? <span class="gsv-console-detail-action-error">{disconnectError}</span> : null}
          </div>
        )}
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
      {confirmDisconnect ? (
        <div class="gsv-console-confirm-layer" onClick={() => setConfirmDisconnect(false)}>
          <div class="gsv-console-confirm-wrap" onClick={(event) => event.stopPropagation()}>
            <ConfirmModal
              title="CONFIRM DISCONNECT"
              message={`Disconnect messenger bot "${adapterLabel(adapter)}"?`}
              note="The bot connection is removed. Linked identities are not deleted."
              confirmLabel="DISCONNECT BOT"
              confirmPhrase={adapter.accountId}
              confirmInputPlaceholder={adapter.accountId}
              onCancel={() => setConfirmDisconnect(false)}
              onConfirm={() => {
                onDisconnect?.(adapter);
                setConfirmDisconnect(false);
              }}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
