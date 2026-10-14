import { useGateway } from "../../../services/gateway/GatewayProvider";
import { useInfiniteQuery } from "../../../services/navigation/viewQueries";
import { instrumentContactConversationKey } from "../wire/queryKeys";

const NO_SEQUENCE: number | null = null;

/** People and its Zen panel observe the same paginated conversation. */
export function useContactHistory(conversationId: string, enabled: boolean) {
  const { client, connected } = useGateway();
  return useInfiniteQuery({
    queryKey: instrumentContactConversationKey(conversationId),
    enabled: connected && enabled,
    initialPageParam: NO_SEQUENCE,
    queryFn: ({ pageParam }) => client.conversation.history({ conversationId, limit: 50, beforeSequence: pageParam ?? undefined }),
    getNextPageParam: (page) => page.hasMore ? page.messages[0]?.sequence : undefined,
  });
}
