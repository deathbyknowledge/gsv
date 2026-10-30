import { useEffect, useState } from "preact/hooks";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useViewActive } from "../../../services/navigation/ViewActivity";
import { contactInvitationUrl, parseContactInvitation, type ContactInviteCreateResult } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { contactInvitationPreview, clearContactInvitation } from "../../../services/session/contactInvitationIntent";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_CONTACTS_KEY, INSTRUMENT_CONTACT_INVITES_KEY } from "../wire/queryKeys";
import { ContactHandlingChoice } from "./ContactHandlingChoice";
import { submitOnEnter } from "../shared/enterToSend";
import { useT, type TextKey } from "../../../i18n/locale";

export type InvitationDraft = { code: string; issued: ContactInviteCreateResult | null; shipHandlesMessages: boolean | null };

export function InviteContact({ account, draft, onChange, onAdded, onBusy, onProfile }: {
  account: ConsoleAccount | undefined;
  draft: InvitationDraft;
  onChange: (draft: InvitationDraft) => void;
  onAdded: (contactId: string) => void;
  onBusy: (busy: boolean) => void;
  onProfile: () => void;
}) {
  const t = useT();
  const active = useViewActive();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [copyStatus, setCopyStatus] = useState<TextKey | null>(null);
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
    if (draft.shipHandlesMessages === null) throw new Error(t("people.handling.required"));
    return client.contact.invite.create({ expiresInSeconds: 7 * 24 * 60 * 60, shipHandlesMessages: draft.shipHandlesMessages });
  },
    onSuccess: (invite) => { onChange({ ...draft, issued: invite }); setCopyStatus(null); void refreshInvites(); } });
  const accept = useMutation({ mutationFn: () => {
    if (draft.shipHandlesMessages === null) throw new Error(t("people.handling.required"));
    return client.contact.invite.accept({ code: parseContactInvitation(draft.code).code, shipHandlesMessages: draft.shipHandlesMessages });
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
      {entering && <p class="people-note">{t("people.invite.paste")}</p>}
      <form class="people-form" onSubmit={(event) => { event.preventDefault(); if (!busy && allowed("contact.invite.accept") && draft.shipHandlesMessages !== null && preview && "name" in preview && !preview.expired) accept.mutate(); }}>
        {entering && <label>{t("people.invite.codeLabel")}<textarea rows={2} value={draft.code} autoComplete="off" spellcheck={false} disabled={busy} onInput={(event) => { accept.reset(); onChange({ ...draft, code: event.currentTarget.value, shipHandlesMessages: null }); }}
          onKeyDown={submitOnEnter} /></label>}
        {preview && ("error" in preview ? <p class="people-error" role="alert">{preview.error}</p> : <div class="people-invite-person"><h2>{preview.name}</h2><span>{preview.handle}</span><p class="people-note">{t(preview.expired ? "people.invite.expired" : "people.invite.connectHint")}</p></div>)}
        {preview && "name" in preview && !preview.expired && choice}
        <button class="ibtn is-primary" type="submit" disabled={busy || !allowed("contact.invite.accept") || draft.shipHandlesMessages === null || !preview || "error" in preview || preview.expired}>{t(accept.isPending ? "people.invite.connecting" : "people.invite.accept")}</button>
      </form>
      <div class="people-actions">{!entering && <button class="people-action" disabled={busy} onClick={() => setEntering(true)}>{t("people.invite.useDifferent")}</button>}
        <button class="people-action" disabled={busy} onClick={() => { clearContactInvitation(); onChange({ code: "", issued: null, shipHandlesMessages: null }); setAccepting(false); setEntering(true); }}>{t("people.invite.inviteInstead")}</button></div>
    </> : <>
      <h2>{t("people.invite.title")}</h2>
      <p class="people-note">{t("people.invite.intro")}</p>
      {issued && link ? <div class="people-invite-link">
        {expired || current?.state === "cancelled" ? <p role="status">{t(expired ? "people.invite.hasExpired" : "people.invite.wasCancelled")}</p> : <>
          <label>{t("people.invite.link")}<input aria-label={t("people.invite.link")} value={link} readOnly onFocus={(event) => event.currentTarget.select()} /></label>
          <div class="people-actions"><button class="ibtn is-primary" onClick={async () => {
            try { await navigator.clipboard.writeText(link); setCopyStatus("people.invite.copied"); }
            catch { setCopyStatus("people.invite.selectToCopy"); }
          }}>{t("people.invite.copy")}</button><span class="people-note" role="status">{t(copyStatus ?? "people.invite.ready")}</span></div>
          <p class="people-note">{t("people.invite.forOne", { date: new Date(issued.expiresAtMs).toLocaleDateString(undefined, { month: "short", day: "numeric" }) })}</p>
        </>}
        <div class="people-actions"><button class="people-action" disabled={busy} onClick={() => onChange({ ...draft, issued: null, shipHandlesMessages: null })}>{t("people.invite.another")}</button>
          {!expired && current?.state !== "cancelled" && <button class="people-action" disabled={busy || !allowed("contact.invite.cancel")} onClick={() => cancel.mutate(issued.inviteId)}>{t("people.invite.cancel")}</button>}</div>
      </div> : <>{choice}<button class="ibtn is-primary" disabled={busy || !allowed("contact.invite.create") || draft.shipHandlesMessages === null} onClick={() => create.mutate()}>{t(create.isPending ? "people.invite.creating" : "people.invite.create")}</button></>}
      <div class="people-compose-footer"><button class="people-action" disabled={busy || !allowed("contact.invite.accept")} onClick={() => { onChange({ ...draft, issued: null, shipHandlesMessages: null }); setAccepting(true); }}>{t("people.invite.have")}</button><button class="people-action" disabled={busy} onClick={onProfile}>{t("people.invite.useProfile")}</button></div>
      {pendingInvites.length > 0 && <details class="people-details-fold"><summary>{t("people.invite.pending", { count: pendingInvites.length })}</summary>
        {pendingInvites.map((item) => <div class="people-actions" key={item.inviteId}><span class="people-note">{t("people.invite.expiresOn", { date: new Date(item.expiresAtMs).toLocaleDateString() })}</span><button class="people-action" disabled={busy || !allowed("contact.invite.cancel")} onClick={() => cancel.mutate(item.inviteId)}>{t("common.cancel")}</button></div>)}
      </details>}
    </>}
    {error && <p class="people-error" role="alert">{error.message}</p>}
    {!connected && <p class="people-note" role="status">{t("people.invite.reconnecting")}</p>}
  </section>;
}
