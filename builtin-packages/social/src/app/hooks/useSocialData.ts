import { useCallback, useEffect, useState } from "preact/hooks";
import type {
  EstablishContactArgs,
  PendingAction,
  RemoveContactArgs,
  SendMessageArgs,
  SetContactGrantsArgs,
  SocialBackend,
  SocialRoute,
  SocialState,
  UpdateMessageWorkflowArgs,
} from "../types";
import { formatError } from "../utils/format";

export type SocialDataController = {
  state: SocialState | null;
  pendingAction: PendingAction | null;
  error: string | null;
  refresh: () => Promise<void>;
  clearError: () => void;
  establishContact: (args: EstablishContactArgs) => Promise<SocialState | null>;
  setContactGrants: (args: SetContactGrantsArgs) => Promise<SocialState | null>;
  removeContact: (args: RemoveContactArgs) => Promise<SocialState | null>;
  sendMessage: (args: SendMessageArgs) => Promise<SocialState | null>;
  updateMessageWorkflow: (args: UpdateMessageWorkflowArgs) => Promise<SocialState | null>;
  republishPublicRecords: () => Promise<SocialState | null>;
};

export function useSocialData(backend: SocialBackend, route: SocialRoute): SocialDataController {
  const [state, setState] = useState<SocialState | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setPendingAction("load");
    try {
      const nextState = await backend.loadState({
        channelId: route.channelId,
        contactHandle: route.contactHandle,
      });
      setState(nextState);
      setError(null);
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      setPendingAction(null);
    }
  }, [backend, route.channelId, route.contactHandle]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runStateAction = useCallback(async (
    actionId: PendingAction,
    action: () => Promise<SocialState>,
  ): Promise<SocialState | null> => {
    setPendingAction(actionId);
    try {
      const nextState = await action();
      const nextContactHandle = route.contactHandle && nextState.contacts.some((contact) => contact.handle === route.contactHandle)
        ? route.contactHandle
        : null;
      const hydratedState = await backend.loadState({
        channelId: nextState.selectedChannel?.channel?.channelId ?? route.channelId,
        contactHandle: nextContactHandle,
      });
      setState(hydratedState);
      setError(null);
      return hydratedState;
    } catch (cause) {
      setError(formatError(cause));
      return null;
    } finally {
      setPendingAction(null);
    }
  }, [backend, route.channelId, route.contactHandle]);

  return {
    state,
    pendingAction,
    error,
    refresh,
    clearError: () => setError(null),
    establishContact: (args) => runStateAction("establish-contact", () => backend.establishContact(args)),
    setContactGrants: (args) => runStateAction("save-contact-grants", () => backend.setContactGrants(args)),
    removeContact: (args) => runStateAction("remove-contact", () => backend.removeContact(args)),
    sendMessage: (args) => runStateAction("send-message", () => backend.sendMessage(args)),
    updateMessageWorkflow: (args) => runStateAction("update-message-workflow", () => backend.updateMessageWorkflow(args)),
    republishPublicRecords: () => runStateAction("republish-public-records", () => backend.republishPublicRecords()),
  };
}
