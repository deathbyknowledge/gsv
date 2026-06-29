import { useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { ConfirmModal } from "../../../components/ui/ConfirmModal";
import { ConsoleDetailPage } from "../components/ConsoleDetailPage";
import type { ConsoleMcpServer } from "../domain/consoleModels";
import {
  integrationIcon,
  mcpServerBlurb,
  mcpServerDetailSections,
  statusForMcpServer,
  toneForMcpServer,
} from "./integrationPresentation";

type IntegrationDetailPageProps = {
  actionError?: string;
  onBack: () => void;
  onRefresh: (serverId: string) => void;
  onRemove: (serverId: string) => void;
  removing?: boolean;
  refreshing?: boolean;
  server: ConsoleMcpServer;
};

export function IntegrationDetailPage({
  actionError = "",
  onBack,
  onRefresh,
  onRemove,
  removing = false,
  refreshing = false,
  server,
}: IntegrationDetailPageProps) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const authUrl = server.authUrl.trim();
  const primaryLabel = authUrl
    ? "CONTINUE SIGN-IN"
    : refreshing
      ? "REFRESHING"
      : "REFRESH";

  return (
    <>
      <ConsoleDetailPage
        actions={(
          <div class="gsv-console-detail-actions">
            <Button
              variant="dangerGhost"
              label={removing ? "REMOVING" : "REMOVE INTEGRATION"}
              disabled={refreshing || removing}
              onClick={() => setConfirmRemove(true)}
            />
            {actionError ? <span class="gsv-console-detail-action-error">{actionError}</span> : null}
          </div>
        )}
        icon={integrationIcon(server)}
        title={server.name}
        typeLabel="GSV · INTEGRATION"
        statusLabel={statusForMcpServer(server)}
        tone={toneForMcpServer(server)}
        blurb={mcpServerBlurb(server)}
        parentLabel="INTEGRATIONS"
        primaryLabel={primaryLabel}
        onPrimary={authUrl ? () => window.open(authUrl, "_blank", "noopener,noreferrer") : () => onRefresh(server.serverId)}
        sections={mcpServerDetailSections(server)}
        onBack={onBack}
      />
      {confirmRemove ? (
        <div class="gsv-console-confirm-layer" onClick={() => setConfirmRemove(false)}>
          <div class="gsv-console-confirm-wrap" onClick={(event) => event.stopPropagation()}>
            <ConfirmModal
              title="CONFIRM REMOVE"
              message={`Remove integration "${server.name}"?`}
              note="The MCP server connection and discovered tools are removed from GSV."
              confirmLabel="REMOVE INTEGRATION"
              confirmPhrase={server.name}
              confirmInputPlaceholder={server.name}
              onCancel={() => setConfirmRemove(false)}
              onConfirm={() => {
                onRemove(server.serverId);
                setConfirmRemove(false);
              }}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
