import { useQueryClient } from "@tanstack/preact-query";
import { useEffect } from "preact/hooks";
import { useGateway } from "../gateway/GatewayProvider";
import { ADAPTER_STATUS_QUERY_KEYS } from "./gatewaySignalQueryKeys";

export function GatewaySignalInvalidator() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  useEffect(() => {
    return client.onSignal((signal) => {
      if (signal === "mcp.changed") {
        void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
        return;
      }

      if (
        signal === "notification.created" ||
        signal === "notification.updated" ||
        signal === "notification.dismissed"
      ) {
        void queryClient.invalidateQueries({ queryKey: ["notifications"] });
        return;
      }

      if (signal === "proc.changed") {
        void queryClient.invalidateQueries({ queryKey: ["processes"] });
        void queryClient.invalidateQueries({ queryKey: ["process"] });
        return;
      }

      if (
        signal === "process.exit" ||
        signal === "proc.run.started" ||
        signal === "proc.run.retrying" ||
        signal === "proc.run.tool.started" ||
        signal === "proc.run.hil.requested"
      ) {
        void queryClient.invalidateQueries({ queryKey: ["processes"] });
        return;
      }

      if (signal === "proc.run.finished") {
        void queryClient.invalidateQueries({ queryKey: ["processes"] });
        void queryClient.invalidateQueries({ queryKey: ["process"] });
        return;
      }

      if (signal === "device.status") {
        void queryClient.invalidateQueries({ queryKey: ["devices"] });
        return;
      }

      if (signal === "adapter.status") {
        for (const queryKey of ADAPTER_STATUS_QUERY_KEYS) {
          void queryClient.invalidateQueries({ queryKey });
        }
      }
    });
  }, [client, queryClient]);

  return null;
}
