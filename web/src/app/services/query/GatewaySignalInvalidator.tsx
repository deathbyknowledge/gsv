import type { GSVClient } from "@humansandmachines/gsv/client";
import { type QueryClient, useQueryClient } from "@tanstack/preact-query";
import { useEffect } from "preact/hooks";
import { useGateway } from "../gateway/GatewayProvider";
import { ADAPTER_STATUS_QUERY_KEYS } from "./gatewaySignalQueryKeys";

export function GatewaySignalInvalidator() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  useEffect(() => watchGatewayQueries(client, queryClient), [client, queryClient]);
  return null;
}

export function watchGatewayQueries(
  client: Pick<GSVClient, "getStatus" | "onStatus" | "onSignal">,
  queryClient: QueryClient,
): () => void {
  let connectionId = client.getStatus().connectionId;
  const stopStatus = client.onStatus((status) => {
    if (status.state !== "connected") return;
    if (connectionId && status.connectionId !== connectionId) {
      // Recover changes missed while disconnected, including fresh cached queries.
      void queryClient.invalidateQueries();
    }
    connectionId = status.connectionId;
  });
  const stopSignals = client.onSignal((signal) => {
    if (signal === "mcp.changed") {
      void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      return;
    }

    if (signal === "proc.changed") {
      void queryClient.invalidateQueries({ queryKey: ["processes"] });
      return;
    }

    if (
      signal === "process.exit" ||
      signal === "proc.run.started" ||
      signal === "proc.run.retrying" ||
      signal === "proc.run.tool.started" ||
      signal === "proc.run.tool.finished" ||
      signal === "proc.run.hil.requested"
    ) {
      void queryClient.invalidateQueries({ queryKey: ["processes"] });
      void queryClient.invalidateQueries({ queryKey: ["process", "trace"] });
      return;
    }

    if (signal === "proc.run.finished") {
      void queryClient.invalidateQueries({ queryKey: ["processes"] });
      return;
    }

    if (signal === "target.status") {
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
      return;
    }

    if (signal === "adapter.status") {
      for (const queryKey of ADAPTER_STATUS_QUERY_KEYS) {
        void queryClient.invalidateQueries({ queryKey });
      }
    }
  });
  return () => { stopStatus(); stopSignals(); };
}
