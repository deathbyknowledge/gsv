import { useQuery } from "@tanstack/preact-query";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleAccounts } from "../../../services/system/consoleService";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_APPROACHES_KEY, INSTRUMENT_ATTENTION_KEY } from "../wire/queryKeys";

export function useAttentionSummary() {
  const { client, connected } = useGateway();
  const accounts = useQuery({ queryKey: ["fleet", "accounts"], queryFn: () => loadConsoleAccounts(client), enabled: connected });
  const account = accounts.data?.find((entry) => entry.relation === "self");
  const mayReadMessages = !!account && account.uid >= 1000 && canConfigure(account, "conversation.attention.list");
  const mayReadRequests = !!account && account.uid >= 1000 && canConfigure(account, "approach.list");
  const messages = useQuery({
    queryKey: [...INSTRUMENT_ATTENTION_KEY, "summary"],
    enabled: connected && mayReadMessages,
    queryFn: () => client.conversation.attention.list({ limit: 1 }),
    staleTime: 30_000,
  });
  const requests = useQuery({
    queryKey: [...INSTRUMENT_APPROACHES_KEY, "attention-summary"],
    enabled: connected && mayReadRequests,
    queryFn: () => client.approach.list({ direction: "incoming", status: "active", limit: 1 }),
    staleTime: 30_000,
  });
  const requestCount = mayReadRequests ? requests.data?.total ?? 0 : 0;
  return {
    readyCount: (mayReadMessages ? messages.data?.readyCount ?? 0 : 0) + requestCount,
    requestCount,
    digestWaitingCount: mayReadMessages ? messages.data?.digestWaitingCount ?? 0 : 0,
  };
}
