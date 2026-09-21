import { useQuery } from "@tanstack/preact-query";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleAccounts } from "../../../services/system/consoleService";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_ATTENTION_KEY } from "../wire/queryKeys";

export function useAttentionSummary() {
  const { client, connected } = useGateway();
  const accounts = useQuery({ queryKey: ["fleet", "accounts"], queryFn: () => loadConsoleAccounts(client), enabled: connected });
  const account = accounts.data?.find((entry) => entry.relation === "self");
  return useQuery({
    queryKey: [...INSTRUMENT_ATTENTION_KEY, "summary"],
    enabled: connected && !!account && account.uid >= 1000 && canConfigure(account, "conversation.attention.list"),
    queryFn: () => client.conversation.attention.list({ limit: 1 }),
    staleTime: 30_000,
  });
}
