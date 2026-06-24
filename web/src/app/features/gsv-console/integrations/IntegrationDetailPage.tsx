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
  onBack: () => void;
  onRefresh: (serverId: string) => void;
  refreshing?: boolean;
  server: ConsoleMcpServer;
};

export function IntegrationDetailPage({
  onBack,
  onRefresh,
  refreshing = false,
  server,
}: IntegrationDetailPageProps) {
  const authUrl = server.authUrl.trim();
  const primaryLabel = authUrl
    ? "CONTINUE SIGN-IN"
    : refreshing
      ? "REFRESHING"
      : "REFRESH";

  return (
    <ConsoleDetailPage
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
  );
}
