import { useQueryClient } from "@tanstack/preact-query";
import type { ProcHilRequest } from "@humansandmachines/gsv/protocol";
import { useCallback, useMemo, useState } from "preact/hooks";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadConsoleProcesses } from "../../../services/system/consoleService";
import { consoleConfigQueryKey, useConsoleAccounts, useConsoleConfig } from "../../../services/system/useConsoleData";
import { accountApprovalKey, saveAccountApprovalPolicy, type ApprovalPolicySource } from "../../../services/system/approvalPolicyService";
import { approvalPolicyAccount, approvalRuleForRequest, protectManagedMailApproval, upsertApprovalRule } from "../../../domain/agentApproval";
import { GLOBAL_APPROVAL_CONFIG_KEY, defaultApprovalPolicyForConfig, parseApprovalPolicy, serializeApprovalPolicy } from "../../../domain/system/consoleAgentBehavior";
import { canConfigure, readSettingsPolicy } from "../settings/settingsModel";
import { INSTRUMENT_PROCESSES_KEY } from "../wire/queryKeys";

/** Why no rule can be written from a card: the viewer lacks the settings capability, or the saved policy cannot be rewritten losslessly. */
export type AccountApprovalBlock = "capability" | "policy";

export type AccountApproval = {
  /** The account whose approval override a persistent choice writes; null until the process and its account are known. */
  policyUid: number | null;
  /** The policy the account inherits, and its own override if it has one, as stored. */
  inherited: string;
  override: string;
  inheritedSource: ApprovalPolicySource;
  /** A persistent rule may be written: the settings snapshot is loaded, the viewer may edit it, and the policy round-trips losslessly. */
  editable: boolean;
  /** Set once the snapshot and process are known but nothing may be written; null while loading or when editable. */
  blocked: AccountApprovalBlock | null;
  /** Save an allow rule for exactly this request's capability and place. Resolves true once the rule is stored. */
  allowAlways: (request: ProcHilRequest) => Promise<boolean>;
  /** The request whose rule is being written or failed to write, so a card shows its own state only. */
  pending: { requestId: string; saving: boolean; error: string | null } | null;
  refresh: () => Promise<void>;
};

/** The account approval policy a pending process resolves, and the always-allow rule a card writes into it.
 *  The Kernel reads the run-as account's own override before the owner's, so the rule goes where that
 *  process will actually read it. Nothing persistent is offered until the settings snapshot has loaded,
 *  and a policy Settings cannot edit losslessly is never rewritten from a card. */
export function useAccountApproval({ pid, enabled = true }: { pid: string | null; enabled?: boolean }): AccountApproval {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const config = useConsoleConfig({ enabled });
  const accounts = useConsoleAccounts({ enabled });
  const processes = useQuery({ queryKey: INSTRUMENT_PROCESSES_KEY, queryFn: () => loadConsoleProcesses(client), enabled: connected && enabled });
  const configEntry = (key: string) => config.data?.find((entry) => entry.key === key)?.value ?? "";
  const self = accounts.data?.find((account) => account.relation === "self") ?? null;
  const process = pid === null ? undefined : processes.data?.find((entry) => entry.pid === pid);
  /* a process entry's uid is its owner; its run-as account is found by username in the accounts list */
  const processUid = process === undefined ? null
    : accounts.data?.find((account) => account.username === process.username)?.uid ?? null;
  const policyUid = process?.uid == null ? null : approvalPolicyAccount({
    ownerUid: process.uid, processUid, processOverride: processUid === null ? "" : configEntry(accountApprovalKey(processUid)),
  });
  const override = policyUid === null ? "" : configEntry(accountApprovalKey(policyUid));
  const inherited = defaultApprovalPolicyForConfig(config.data ?? []);
  const inheritedValue = configEntry(GLOBAL_APPROVAL_CONFIG_KEY);
  const inheritedSource = useMemo(() => ({ key: GLOBAL_APPROVAL_CONFIG_KEY, value: inheritedValue }), [inheritedValue]);
  const known = config.data !== undefined && self !== null && policyUid !== null;
  const lossless = (override === "" || readSettingsPolicy(override) !== null) && readSettingsPolicy(inherited) !== null;
  const editable = known && canConfigure(self, "sys.config.set") && lossless;
  const blocked: AccountApprovalBlock | null = !known || editable ? null : !canConfigure(self, "sys.config.set") ? "capability" : "policy";

  const refresh = useCallback(async () => { await cache.invalidateQueries({ queryKey: consoleConfigQueryKey }); }, [cache]);
  const [pending, setPending] = useState<AccountApproval["pending"]>(null);
  const allowAlways = useCallback(async (request: ProcHilRequest) => {
    if (policyUid === null) return false;
    setPending({ requestId: request.requestId, saving: true, error: null });
    try {
      const base = parseApprovalPolicy(override || inherited);
      const next = protectManagedMailApproval(upsertApprovalRule(base, approvalRuleForRequest(request.syscall, request.target)));
      await saveAccountApprovalPolicy(client, policyUid, override, serializeApprovalPolicy(next), inheritedSource);
      await refresh();
    } catch (error) {
      /* the snapshot may be stale: reload so the next attempt composes against what is saved now */
      await refresh().catch(() => {});
      setPending({ requestId: request.requestId, saving: false, error: error instanceof Error ? error.message : "The rule did not save." });
      return false;
    }
    setPending(null);
    return true;
  }, [client, inherited, inheritedSource, override, policyUid, refresh]);

  return { policyUid, inherited, override, inheritedSource, editable, blocked, allowAlways, pending, refresh };
}
