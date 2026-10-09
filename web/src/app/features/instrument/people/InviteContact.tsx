import { useEffect, useState } from "preact/hooks";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useViewActive } from "../../../services/navigation/ViewActivity";
import { contactInvitationUrl, type ContactInviteCreateResult } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { contactInvitationPreview, clearContactInvitation } from "../../../services/session/contactInvitationIntent";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_CONTACTS_KEY, INSTRUMENT_CONTACT_INVITES_KEY } from "../wire/queryKeys";
import { ContactHandlingChoice } from "./ContactHandlingChoice";

export type InvitationDraft = { code: string; issued: ContactInviteCreateResult | null; shipHandlesMessages: boolean | null };

export function InviteContact({ account, draft, onChange, onAdded, onBusy, onProfile }: {
  account: ConsoleAccount | undefined;
  draft: InvitationDraft;
  onChange: (draft: InvitationDraft) => void;
  onAdded: (contactId: string) => void;
  onBusy: (busy: boolean) => void;
  onProfile: () => void;
}) {
  const active = useViewActive();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [copyStatus, setCopyStatus] = useState("");
  const [accepting, setAccepting] = useState(!!draft.code);
  const [entering, setEntering] = useState(!draft.code);
  const [now, setNow] = useState(Date.now());
  const allowed = (name: string) => connected && !!account && canConfigure(account, name);
  const invites = useQuery({ queryKey: INSTRUMENT_CONTACT_INVITES_KEY, enabled: allowed("contact.invite.list"),
    queryFn: async () => (await client.contact.invite.list({ includeTerminal: true })).invites });
  const issued = draft.issued;
  const current = invites.data?.find((item) => item.inviteId === issued?.inviteId);
  const refreshInvites = () => cache.invalidateQueries({ queryKey: INSTRUMENT_CONTACT_INVITES_KEY });
  const create = useMutation({ mutationFn: () => {
    if (draft.shipHandlesMessages === null) throw new Error("Choose who should handle new messages");
    return client.contact.invite.create({ expiresInSeconds: 7 * 24 * 60 * 60, shipHandlesMessages: draft.shipHandlesMessages });
  },
    onSuccess: (invite) => { onChange({ ...draft, issued: invite }); setCopyStatus(""); void refreshInvites(); } });
  const accept = useMutation({ mutationFn: () => {
    if (draft.shipHandlesMessages === null) throw new Error("Choose who should handle new messages");
    return client.contact.invite.accept({ code: draft.code.trim(), shipHandlesMessages: draft.shipHandlesMessages });
  },
    onSuccess: async ({ contact }) => {
      clearContactInvitation(); onChange({ code: "", issued: null, shipHandlesMessages: null });
      await cache.invalidateQueries({ queryKey: INSTRUMENT_CONTACTS_KEY }); onAdded(contact.id);
    } });
  const cancel = useMutation({ mutationFn: (inviteId: string) => client.contact.invite.cancel({ inviteId }),
    onSuccess: () => { onChange({ ...draft, issued: null, shipHandlesMessages: null }); void refreshInvites(); } });
  const busy = create.isPending || accept.isPending || cancel.isPending;
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  useEffect(() => {
    if (!active || !issued || issued.expiresAtMs <= Date.now()) return;
    const timer = setTimeout(() => setNow(Date.now()), issued.expiresAtMs - Date.now());
    return () => clearTimeout(timer);
  }, [active, issued]);
  useEffect(() => {
    if (active && current?.state === "accepted" && current.contactId) {
      onChange({ code: "", issued: null, shipHandlesMessages: null }); onAdded(current.contactId);
    }
  }, [active, current?.state, current?.contactId]);
  const preview = draft.code.trim() ? contactInvitationPreview(draft.code) : null;
  const expired = !!issued && issued.expiresAtMs <= Math.max(now, Date.now());
  const link = issued && (issued.url ?? contactInvitationUrl(issued.code, `${window.location.origin}/connect`));
  const error = create.error ?? accept.error ?? cancel.error ?? invites.error;
  const pendingInvites = invites.data?.filter((item) => item.state === "pending" && item.expiresAtMs > Date.now() && item.inviteId !== issued?.inviteId) ?? [];
  const choice = <ContactHandlingChoice value={draft.shipHandlesMessages} disabled={busy || !allowed("contact.preferences.update")} onChange={(shipHandlesMessages) => onChange({ ...draft, shipHandlesMessages })} />;

  return <section class="people-invite">
    {accepting ? <>
      {entering && <p class="people-note">Paste the invitation they shared with you.</p>}
      <form class="people-form" onSubmit={(event) => { event.preventDefault(); if (!busy && allowed("contact.invite.accept") && draft.shipHandlesMessages !== null && preview && "name" in preview && !preview.expired) accept.mutate(); }}>
        {entering && <label>Invitation link or code<textarea rows={2} value={draft.code} autoComplete="off" spellcheck={false} disabled={busy} onInput={(event) => { accept.reset(); onChange({ ...draft, code: event.currentTarget.value, shipHandlesMessages: null }); }} /></label>}
        {preview && ("error" in preview ? <p class="people-error" role="alert">{preview.error}</p> : <div class="people-invite-person"><h2>{preview.name}</h2><span>{preview.origin}</span><p class="people-note">{preview.expired ? "This invitation has expired. Ask them for a new link." : "Connect to message each other and ask your Ships to help."}</p></div>)}
        {preview && "name" in preview && !preview.expired && choice}
        <button class="ibtn is-primary" type="submit" disabled={busy || !allowed("contact.invite.accept") || draft.shipHandlesMessages === null || !preview || "error" in preview || preview.expired}>{accept.isPending ? "connecting…" : "accept invitation"}</button>
      </form>
      <div class="people-actions">{!entering && <button class="people-action" disabled={busy} onClick={() => setEntering(true)}>use a different invitation</button>}
        <button class="people-action" disabled={busy} onClick={() => { clearContactInvitation(); onChange({ code: "", issued: null, shipHandlesMessages: null }); setAccepting(false); setEntering(true); }}>invite someone instead</button></div>
    </> : <>
      <h2>Bring someone along.</h2>
      <p class="people-note">Send a link to a friend, partner, or colleague who has GSV. Once they accept, you can talk here and put your Ships to work together.</p>
      {issued && link ? <div class="people-invite-link">
        {expired || current?.state === "cancelled" ? <p role="status">This invitation {expired ? "has expired" : "was cancelled"}.</p> : <>
          <label>Invitation link<input aria-label="Invitation link" value={link} readOnly onFocus={(event) => event.currentTarget.select()} /></label>
          <div class="people-actions"><button class="ibtn is-primary" onClick={async () => {
            try { await navigator.clipboard.writeText(link); setCopyStatus("Link copied. Send it wherever you talk."); }
            catch { setCopyStatus("Select the link above to copy it."); }
          }}>copy link</button><span class="people-note" role="status">{copyStatus || "Ready to share"}</span></div>
          <p class="people-note">For one person · expires {new Date(issued.expiresAtMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</p>
        </>}
        <div class="people-actions"><button class="people-action" disabled={busy} onClick={() => onChange({ ...draft, issued: null, shipHandlesMessages: null })}>invite another person</button>
          {!expired && current?.state !== "cancelled" && <button class="people-action" disabled={busy || !allowed("contact.invite.cancel")} onClick={() => cancel.mutate(issued.inviteId)}>cancel this invitation</button>}</div>
      </div> : <>{choice}<button class="ibtn is-primary" disabled={busy || !allowed("contact.invite.create") || draft.shipHandlesMessages === null} onClick={() => create.mutate()}>{create.isPending ? "creating link…" : "create invitation link"}</button></>}
      <div class="people-compose-footer"><button class="people-action" disabled={busy || !allowed("contact.invite.accept")} onClick={() => { onChange({ ...draft, issued: null, shipHandlesMessages: null }); setAccepting(true); }}>I have an invitation</button><button class="people-action" disabled={busy} onClick={onProfile}>use a profile address</button></div>
      {pendingInvites.length > 0 && <details class="people-details-fold"><summary>{pendingInvites.length} pending invitation{pendingInvites.length === 1 ? "" : "s"}</summary>
        {pendingInvites.map((item) => <div class="people-actions" key={item.inviteId}><span class="people-note">Expires {new Date(item.expiresAtMs).toLocaleDateString()}</span><button class="people-action" disabled={busy || !allowed("contact.invite.cancel")} onClick={() => cancel.mutate(item.inviteId)}>cancel</button></div>)}
      </details>}
    </>}
    {error && <p class="people-error" role="alert">{error.message}</p>}
    {!connected && <p class="people-note" role="status">Reconnecting… Your invitation is kept here.</p>}
  </section>;
}
