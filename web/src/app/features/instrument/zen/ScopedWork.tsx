import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useEffect, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { LoadingState } from "../../../components/ui/Spinner";
import { INSTRUMENT_CONTACTS_KEY, INSTRUMENT_PROCESSES_KEY } from "../wire/queryKeys";
import { procSignalSchema } from "../wire/wireModel";

export function useScopedWork(pid: string | null | undefined) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const query = useQuery({ queryKey: [...INSTRUMENT_PROCESSES_KEY, "scope", pid], enabled: connected && !!pid,
    queryFn: () => client.proc.scope.get({ pid: pid! }) });
  const scope = query.data?.scope;
  const contactIds = scope?.policy.conversations.map((entry) => entry.contactId) ?? [];
  const contacts = useQuery({ queryKey: [...INSTRUMENT_CONTACTS_KEY, "helper-scope", scope?.id],
    enabled: connected && contactIds.length > 0,
    queryFn: () => client.contact.list({ ids: contactIds, includeRevoked: true, limit: 8 }) });
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!scope || scope.policy.expiresAtMs <= now) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1, scope.policy.expiresAtMs - Date.now()));
    return () => clearTimeout(timer);
  }, [scope, now]);
  useEffect(() => client.onSignal((signal, payload) => {
    if (!pid || (signal !== "proc.changed" && signal !== "process.exit")) return;
    const event = procSignalSchema.safeParse(payload);
    if (event.success && event.data.pid === pid) void cache.invalidateQueries({ queryKey: [...INSTRUMENT_PROCESSES_KEY, "scope", pid] });
  }), [client, cache, pid]);
  const revoke = useMutation({ mutationFn: () => client.proc.scope.revoke({ pid: pid!, expectedRevision: scope!.revision }), onSettled: () => query.refetch() });
  const currentContacts = contacts.data?.contacts;
  const connectionEnded = !!scope && !!currentContacts && scope.policy.conversations.some((grant) => !currentContacts.some((contact) => contact.id === grant.contactId && contact.state === "active" && contact.generation === grant.generation));
  const ended = !!scope && (scope.state !== "active" || scope.policy.expiresAtMs <= now || connectionEnded);
  const exhausted = !!scope && scope.used.generations >= scope.policy.budgets.generations;
  return { query, contacts, scope, revoke, ended, exhausted,
    checking: !!pid && (!query.isSuccess || contactIds.length > 0 && !contacts.isSuccess), connected };
}

export function ScopedWork({ work, pid, onPeople }: {
  work: ReturnType<typeof useScopedWork>; pid: string;
  onPeople?: (contactId: string, pid: string) => void;
}) {
  const { scope, query, contacts, revoke, ended, exhausted, connected } = work;
  if (query.isSuccess && !scope) return null;
  return <aside class="zen-scoped-work" aria-label="Private helper access">
    {query.isPending ? <LoadingState>Loading this helper’s access…</LoadingState> : scope ? <>
      <div class="zen-scoped-heading"><strong>{ended ? "Helper access ended" : exhausted ? "Helper allowance used" : "Private conversation helper"}</strong>
        {onPeople && scope.policy.conversations[0] && <button type="button" onClick={() => onPeople(scope.policy.conversations[0].contactId, pid)}>← conversation and reply review</button>}
      </div>
      <p>{scope.policy.conversations.some((entry) => entry.read) ? "Can read the reviewed conversation." : "Can read only the selected message copies."} {scope.policy.budgets.messages === 0 ? "Remote replies need your approval." : `${Math.max(0, scope.policy.budgets.messages - scope.used.messages)} remote replies left.`} {Math.max(0, scope.policy.budgets.generations - scope.used.generations)} model requests left.</p>
      <details><summary>Access details</summary><p>{scope.policy.resources.length} selected files · expires {new Date(scope.policy.expiresAtMs).toLocaleString()}.</p>
        <p>Follow-up text stays in this private work. To share different files, targets or conversations, start a fresh helper from People.</p>
        {scope.policy.automatic && <p>Automatic help: {scope.automation?.acceptedMessages ?? 0} of {scope.policy.automatic.maxMessages} incoming messages admitted; {scope.automation?.pendingMessages ?? 0} waiting.{scope.automation?.pausedReason ? ` Paused: ${scope.automation.pausedReason}.` : ""}</p>}
        {!ended && <button type="button" disabled={!connected || revoke.isPending} onClick={() => revoke.mutate()}>{revoke.isPending ? "stopping…" : "stop helper and revoke access"}</button>}
      </details>
    </> : null}
    {(query.error || contacts.error || revoke.error) && <p role="alert">{query.error?.message || contacts.error?.message || revoke.error?.message}<button type="button" disabled={!connected} onClick={() => { void query.refetch(); if (scope?.policy.conversations.length) void contacts.refetch(); }}>retry access check</button></p>}
  </aside>;
}
