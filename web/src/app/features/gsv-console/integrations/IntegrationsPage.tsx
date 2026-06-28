import { useMemo, useState } from "preact/hooks";
import { ListTemplate } from "../list-template/ListTemplate";
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
  const [query, setQuery] = useState("");
  const ready = servers.filter((server) => server.state === "ready");
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return servers
      .filter((server) => !q || server.name.toLowerCase().includes(q))
      .map((server) => ({
        id: integrationDetailId(server),
        icon: integrationIcon(server),
        label: server.name,
        sub: mcpServerSub(server),
        tone: toneForMcpServer(server),
        statusLabel: statusForMcpServer(server),
        tag: server.state === "authenticating" ? { label: "SIGN-IN", tone: "warn" as const } : undefined,
        onOpen: () => onOpenDetail(server),
      }));
  }, [servers, query, onOpenDetail]);

  return (
    <ListTemplate
      listTitle="INTEGRATIONS"
      listMeta={refreshing ? "REFRESHING" : `${ready.length}/${servers.length} READY`}
      emptyObject="INTEGRATIONS"
      rows={rows}
      connectLabel="NEW INTEGRATION"
      onConnect={onOpenCreate}
      search={{ value: query, placeholder: "Search integrations…", onChange: setQuery }}
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
