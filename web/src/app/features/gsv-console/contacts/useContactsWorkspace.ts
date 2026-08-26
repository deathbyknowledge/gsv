import type { ContactSummary } from "@humansandmachines/gsv/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useEffect } from "preact/hooks";

import { useGateway } from "../../../services/gateway/GatewayProvider";
import {
  loadContactsWorkspace,
  loadContactConversation,
  mutateContactsWorkspace,
  sendContactMessage,
  type ContactSendIntent,
  type ContactsMutationResult,
  type ContactsWorkspaceMutation,
} from "./contactsService";

export const contactsWorkspaceQueryKey = ["gsv-console", "contacts"] as const;

export function useContactsWorkspace() {
  const { client, connected } = useGateway();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: contactsWorkspaceQueryKey,
    enabled: connected,
    queryFn: () => loadContactsWorkspace(client),
    refetchInterval: 10_000,
  });
  const mutation = useMutation<ContactsMutationResult, Error, ContactsWorkspaceMutation>({
    mutationFn: (input) => mutateContactsWorkspace(client, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: contactsWorkspaceQueryKey });
    },
  });
  return { connected, query, mutation };
}

export function useContactConversation(contact: ContactSummary | null) {
  const { client, connected } = useGateway();
  const queryClient = useQueryClient();
  const conversationId = contact?.conversationId ?? "";
  const queryKey = ["gsv-console", "contacts", "conversation", conversationId] as const;
  const query = useQuery({
    queryKey,
    enabled: connected && Boolean(contact),
    queryFn: () => loadContactConversation(client, conversationId),
    refetchInterval: 10_000,
  });
  const mutation = useMutation({
    mutationFn: (input: ContactSendIntent) => {
      if (!contact) throw new Error("Select a contact before sending a message");
      return sendContactMessage(client, contact.id, input);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  useEffect(() => {
    if (!connected || !conversationId) return undefined;
    return client.onSignal((signal) => {
      if (signal === "conversation.changed" || signal === "message.committed") {
        void queryClient.invalidateQueries({ queryKey });
      }
    });
  }, [client, connected, conversationId, queryClient]);

  return { query, mutation };
}
