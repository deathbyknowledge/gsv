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
  actionableAdapterError,
  adapterDetailSections,
  adapterLabel,
  adapterSub,
  canDisconnectAdapter,
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
  onRelink?: (adapter: ConsoleAdapterAccount) => void;
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
  onRelink,
}: MessengerDetailPageProps) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [confirmRelink, setConfirmRelink] = useState(false);
  const actionDisabled = disconnecting;
  const isWhatsApp = adapter.adapter === "whatsapp";
  const needsReconnect = !adapter.connected || !adapter.authenticated || Boolean(adapter.error);
  const disconnectLabel = isWhatsApp ? "LOG OUT" : "DISCONNECT BOT";
  const canDisconnect = canDisconnectAdapter(adapter);

  return (
    <>
      <ConsoleDetailPage
        dangerAction={(
          <div class="gsv-console-detail-actions">
            <Button
              variant="dangerGhost"
              label={disconnecting ? (isWhatsApp ? "LOGGING OUT" : "DISCONNECTING") : disconnectLabel}
              disabled={actionDisabled || !canDisconnect || !onDisconnect}
              onClick={() => setConfirmDisconnect(true)}
            />
            {disconnectError ? <span class="gsv-console-detail-action-error">{disconnectError}</span> : null}
          </div>
        )}
        actions={isWhatsApp && onRelink ? (
          <Button
            variant="secondary"
            label="RELINK WITH QR"
            disabled={actionDisabled}
            onClick={() => setConfirmRelink(true)}
          />
        ) : undefined}
        icon={iconForAdapterName(adapter.adapter)}
        title={adapterLabel(adapter)}
        typeLabel="GSV · MESSENGER"
        statusLabel={statusForAdapter(adapter)}
        tone={toneForAdapter(adapter)}
        blurb={actionableAdapterError(adapter.adapter, adapter.error) || adapterSub(adapter)}
        parentLabel="MESSENGERS"
        primaryLabel={needsReconnect ? "RECONNECT" : undefined}
        onPrimary={needsReconnect && onReconnect ? () => onReconnect(adapter) : undefined}
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
              title={isWhatsApp ? "CONFIRM LOG OUT" : "CONFIRM DISCONNECT"}
              message={isWhatsApp
                ? `Log out the WhatsApp account "${adapterLabel(adapter)}" from this GSV?`
                : `Disconnect messenger bot "${adapterLabel(adapter)}"?`}
              note={isWhatsApp
                ? "Linked-device credentials are removed. You will need to scan a new QR code to use this account again. Linked GSV identities are kept."
                : "The bot connection is removed. Linked identities are not deleted."}
              confirmLabel={disconnectLabel}
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
      {confirmRelink ? (
        <div class="gsv-console-confirm-layer" onClick={() => setConfirmRelink(false)}>
          <div class="gsv-console-confirm-wrap" onClick={(event) => event.stopPropagation()}>
            <ConfirmModal
              title="CONFIRM FRESH RELINK"
              message={`Replace the linked-device credentials for "${adapterLabel(adapter)}"?`}
              note="Starting fresh pairing clears the current WhatsApp credentials and requires a new QR scan. Use Reconnect instead when you only need to restore the connection."
              confirmLabel="RELINK WITH QR"
              confirmPhrase={adapter.accountId}
              confirmInputPlaceholder={adapter.accountId}
              onCancel={() => setConfirmRelink(false)}
              onConfirm={() => {
                onRelink?.(adapter);
                setConfirmRelink(false);
              }}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
