import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { conversationViewKey, INSTRUMENT_INBOX_KEY } from "../wire/queryKeys";

export function ConversationViewControls({ conversationId, account }: { conversationId: string; account: ConsoleAccount | undefined }) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const canRead = !!account && account.uid >= 1000 && canConfigure(account, "conversation.view.get");
  const canEdit = canRead && !!account && canConfigure(account, "conversation.view.update");
  const view = useQuery({
    queryKey: conversationViewKey(conversationId), enabled: connected && canRead,
    queryFn: () => client.conversation.view.get({ conversationId }),
  });
  const archive = useMutation({
    mutationFn: () => {
      if (!view.data) throw new Error("Open the conversation before changing its inbox state");
      return client.conversation.view.update({ conversationId, archived: !view.data.entry.view.archived, expectedRevision: view.data.entry.view.revision });
    },
    onSuccess: (result) => {
      cache.setQueryData(conversationViewKey(conversationId), result);
      void cache.invalidateQueries({ queryKey: INSTRUMENT_INBOX_KEY });
    },
  });
  if (!canRead) return null;
  return <div class="people-view-controls">
    {view.data && <button class="fleet-text-action" disabled={!connected || !canEdit || archive.isPending} onClick={() => archive.mutate()}>{archive.isPending ? "updating…" : view.data.entry.view.archived ? "return to inbox" : "archive conversation"}</button>}
    {view.data?.entry.view.archived && <span class="note">Archived · history kept</span>}
    {(view.error ?? archive.error) && <p class="error" role="alert">{(view.error ?? archive.error)?.message}</p>}
  </div>;
}
