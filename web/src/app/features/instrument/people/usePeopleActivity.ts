import { useQuery } from "@tanstack/preact-query";
import type { ApproachSummary, ContactSummary, ConversationInboxEntry } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_APPROACHES_KEY, INSTRUMENT_CONTACTS_KEY, INSTRUMENT_INBOX_KEY } from "../wire/queryKeys";

export type PeopleActivity = {
  conversations: ConversationInboxEntry[];
  requests: ApproachSummary[];
  contacts: ContactSummary[];
  hasMore: boolean;
  error: Error | null;
};

/** The ordinary inbox is durable; WireSync and reconnect invalidation keep these bounded reads current. */
export function usePeopleActivity(viewer: ConsoleAccount | undefined): PeopleActivity {
  const { client, connected } = useGateway();
  const may = (name: string) => !!viewer && viewer.uid >= 1000 && canConfigure(viewer, name);
  const inbox = useQuery({ queryKey: [...INSTRUMENT_INBOX_KEY, "attention"], enabled: connected && may("conversation.inbox"),
    queryFn: () => client.conversation.inbox({ attentionOnly: true, limit: 4 }) });
  const requests = useQuery({ queryKey: [...INSTRUMENT_APPROACHES_KEY, "attention"], enabled: connected && may("approach.list"),
    queryFn: () => client.approach.list({ direction: "incoming", status: "active", limit: 4 }) });
  const contacts = useQuery({ queryKey: INSTRUMENT_CONTACTS_KEY, enabled: connected && may("contact.list"),
    queryFn: () => client.contact.list({ includeRevoked: true }) });
  return { conversations: may("conversation.inbox") ? inbox.data?.entries ?? [] : [],
    requests: may("approach.list") ? requests.data?.approaches ?? [] : [],
    contacts: may("contact.list") ? contacts.data?.contacts ?? [] : [],
    hasMore: !!inbox.data?.next || !!requests.data?.next, error: inbox.error ?? requests.error };
}
