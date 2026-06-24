import { SettingsListPanel } from "../components/SettingsListPanel";
import {
  ConsolePage,
  ConsoleResourceBoundary,
} from "../components/ConsolePageTemplate";
import {
  NEW_DETAIL_ID,
  type ConsoleListSelection,
} from "../domain/consoleListTypes";
import type { ConsoleMcpServer, ConsoleResourceState } from "../domain/consoleModels";
import { useConsoleListSelection } from "../hooks/useConsoleListSelection";
import { useConsoleMcpServers, useRefreshConsoleMcpServer } from "../hooks/useConsoleData";
import { IntegrationDetailPage } from "./IntegrationDetailPage";
import { IntegrationOnboardingFlow } from "./IntegrationOnboardingFlow";
import {
  integrationDetailId,
  integrationIcon,
  mcpServerSub,
  statusForMcpServer,
  toneForMcpServer,
} from "./integrationPresentation";

type IntegrationsPageProps = {
  initialCreate?: boolean;
  initialDetailId?: string | null;
  initialDetailLabel?: string | null;
  onSelectionChange?: (selection: ConsoleListSelection | null) => void;
};

function resourceWithLocalEmptyState<T>(resource: ConsoleResourceState<T>): ConsoleResourceState<T> {
  return { ...resource, isEmpty: false };
}

function IntegrationsConsoleSection({
  onOpenCreate,
  onOpenDetail,
  refreshing,
  servers,
}: {
  onOpenCreate: () => void;
  onOpenDetail: (server: ConsoleMcpServer) => void;
  refreshing: boolean;
  servers: readonly ConsoleMcpServer[];
}) {
  const ready = servers.filter((server) => server.state === "ready");

  return (
    <SettingsListPanel
      title="INTEGRATIONS"
      meta={refreshing ? "REFRESHING" : `${ready.length}/${servers.length} READY`}
      emptyLabel="NO MCP SERVERS"
      rows={servers.map((server) => ({
        id: integrationDetailId(server),
        icon: integrationIcon(server),
        label: server.name,
        sub: mcpServerSub(server),
        tone: toneForMcpServer(server),
        statusLabel: statusForMcpServer(server),
        tag: server.state === "authenticating" ? { label: "SIGN-IN", tone: "warn" } : undefined,
        onOpen: () => onOpenDetail(server),
      }))}
      action={{ label: "NEW INTEGRATION", onClick: onOpenCreate }}
    />
  );
}

function findServer(servers: readonly ConsoleMcpServer[], id: string): ConsoleMcpServer | null {
  return servers.find((server) => integrationDetailId(server) === id) ?? null;
}

export function IntegrationsPage({
  initialCreate = false,
  initialDetailId = null,
  initialDetailLabel = null,
  onSelectionChange,
}: IntegrationsPageProps) {
  const servers = useConsoleMcpServers({ enabled: true });
  const refreshServer = useRefreshConsoleMcpServer();
  const { selectedDetail, selectDetail } = useConsoleListSelection({
    initialCreate,
    initialDetailId,
    initialDetailLabel,
    kind: "integrations",
    onSelectionChange,
  });

  return (
    <ConsolePage flush>
      <ConsoleResourceBoundary
        resource={resourceWithLocalEmptyState(servers.resource)}
        emptyLabel="NO INTEGRATIONS"
        errorLabel="INTEGRATIONS"
        render={(data) => {
          if (selectedDetail?.kind === "integrations" && selectedDetail.createNew) {
            return (
              <IntegrationOnboardingFlow
                onBack={() => selectDetail(null)}
                onCreated={(server) => selectDetail({ kind: "integrations", id: integrationDetailId(server), label: server.name })}
              />
            );
          }

          if (selectedDetail?.kind === "integrations" && selectedDetail.id !== NEW_DETAIL_ID) {
            const server = findServer(data, selectedDetail.id);
            if (server) {
              return (
                <IntegrationDetailPage
                  server={server}
                  refreshing={refreshServer.isPending}
                  onBack={() => selectDetail(null)}
                  onRefresh={(serverId) => void refreshServer.mutateAsync(serverId)}
                />
              );
            }
          }

          return (
            <IntegrationsConsoleSection
              servers={data}
              refreshing={servers.resource.isRefreshing}
              onOpenCreate={() => selectDetail({ kind: "integrations", id: NEW_DETAIL_ID, createNew: true, label: "New integration" })}
              onOpenDetail={(server) => selectDetail({ kind: "integrations", id: integrationDetailId(server), label: server.name })}
            />
          );
        }}
      />
    </ConsolePage>
  );
}
