import { useCallback, useEffect, useState } from "preact/hooks";
import type { GsvBackend } from "../../backend-contract";
import { errorToText } from "../../utils/format";
import type {
  AdministrationState,
  ApplyConfigArgs,
  ConsumeLinkCodeArgs,
  CreateAccessTokenArgs,
  CreateIdentityLinkArgs,
  CreatedAccessToken,
  RemoveIdentityLinkArgs,
  RevokeAccessTokenArgs,
} from "./types";

export function useAdministration(backend: GsvBackend) {
  const [state, setState] = useState<AdministrationState | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [issuedToken, setIssuedToken] = useState<CreatedAccessToken | null>(null);

  const refresh = useCallback(async () => {
    setPendingAction("load-state");
    try {
      setState(await backend.loadAdministrationState());
      setErrorText(null);
    } catch (error) {
      setErrorText(errorToText(error));
    } finally {
      setPendingAction(null);
    }
  }, [backend]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function runStateAction(actionId: string, action: () => Promise<AdministrationState>): Promise<void> {
    setPendingAction(actionId);
    try {
      setState(await action());
      setIssuedToken(null);
      setErrorText(null);
    } catch (error) {
      setErrorText(errorToText(error));
    } finally {
      setPendingAction(null);
    }
  }

  async function createToken(args: CreateAccessTokenArgs): Promise<void> {
    setPendingAction("create-token");
    try {
      const result = await backend.createAccessToken(args);
      setState(result.state);
      setIssuedToken(result.token);
      setErrorText(null);
    } catch (error) {
      setErrorText(errorToText(error));
    } finally {
      setPendingAction(null);
    }
  }

  return {
    state,
    pendingAction,
    errorText,
    issuedToken,
    refresh,
    setErrorText,
    clearIssuedToken: () => setIssuedToken(null),
    saveConfig: (args: ApplyConfigArgs, actionId = "save-config") => runStateAction(actionId, () => backend.applyConfigEntries(args)),
    createToken,
    revokeToken: (args: RevokeAccessTokenArgs) => runStateAction(`revoke:${args.tokenId}`, () => backend.revokeAccessToken(args)),
    consumeLinkCode: (args: ConsumeLinkCodeArgs) => runStateAction("consume-link", () => backend.consumeIdentityLinkCode(args)),
    createLink: (args: CreateIdentityLinkArgs) => runStateAction("create-link", () => backend.createIdentityLink(args)),
    removeLink: (args: RemoveIdentityLinkArgs) => runStateAction(linkActionId(args), () => backend.removeIdentityLink(args)),
  };
}

export function linkActionId(link: RemoveIdentityLinkArgs): string {
  return `unlink:${link.adapter}:${link.accountId}:${link.actorId}`;
}
