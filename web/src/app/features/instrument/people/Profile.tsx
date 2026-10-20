import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useLayoutEffect, useState } from "preact/hooks";
import { profileFieldsSchema, type ProfileFields, type ProfileState } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { LoadingState } from "../../../components/ui/Spinner";
import { INSTRUMENT_PROFILE_KEY } from "../wire/queryKeys";
import { canConfigure } from "../settings/settingsModel";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { rich, useT } from "../../../i18n/locale";

export function Profile({ account, active, onDirty, onBack }: { account: ConsoleAccount; active: boolean; onDirty: (dirty: boolean) => void; onBack: () => void }) {
  const t = useT();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const key = [...INSTRUMENT_PROFILE_KEY, account.uid];
  const [draft, setDraft] = useState<{ revision: number; fields: ProfileFields } | null>(null);
  const canRead = canConfigure(account, "profile.get");
  const profile = useQuery({ queryKey: key, queryFn: async () => (await client.profile.get({})).profile, enabled: connected && active && canRead });
  const refresh = async (state: ProfileState) => {
    await cache.cancelQueries({ queryKey: key, exact: true });
    cache.setQueryData(key, state);
    await cache.invalidateQueries({ queryKey: key, exact: true });
  };
  const save = useMutation({
    mutationFn: async (input: { revision: number; fields: ProfileFields }) => (await client.profile.update({ expectedRevision: input.revision, draft: input.fields })).profile,
    onSuccess: async (state) => { setDraft(null); await refresh(state); },
  });
  const publish = useMutation({ mutationFn: async (revision: number) => (await client.profile.publish({ expectedRevision: revision })).profile, onSuccess: refresh });
  const unpublish = useMutation({
    mutationFn: async (revision: number) => (await client.profile.unpublish({ expectedRevision: revision })).profile,
    onSuccess: async (state, revision) => {
      setDraft((current) => current?.revision === revision ? { ...current, revision: state.revision } : current);
      await refresh(state);
    },
  });
  const pending = save.isPending || publish.isPending || unpublish.isPending;
  const state = profile.data;
  const fields = draft?.fields ?? state?.draft;
  const dirty = draft !== null;
  const stale = !!draft && !!state && draft.revision !== state.revision;
  const valid = !!fields && !!fields.displayName.trim() && profileFieldsSchema.safeParse(fields).success;
  const edit = (patch: Partial<ProfileFields>) => {
    if (!state || !fields) return;
    setDraft({ revision: draft?.revision ?? state.revision, fields: { ...fields, ...patch } });
  };
  const editable = connected && canConfigure(account, "profile.update") && !pending;
  useLayoutEffect(() => { onDirty(dirty || pending); }, [dirty, pending, onDirty]);
  const error = profile.error ?? save.error ?? publish.error ?? unpublish.error;

  return <section class="people-profile" aria-labelledby="people-profile-title">
    <header class="people-conversation-header">
      <button type="button" class="people-action people-conversation-back" aria-label={t("people.back.label")} onClick={onBack}>←</button>
      <div class="people-conversation-title"><h1 id="people-profile-title">{t("people.profile.title")}</h1></div>
    </header>
    <div class="people-profile-scroll" data-scroll-edge><div class="people-own-profile">
    <p class="people-note">{t("people.profile.intro")}</p>
    {!canRead && <p class="people-note">{t("people.profile.noAccess")}</p>}
    {error && <p class="people-error" role="alert">{error.message}</p>}
    {profile.isPending && connected && canRead && <LoadingState variant="panel">{t("people.profile.loading")}</LoadingState>}
    {state && fields && <>
      <p role="status" class="people-note">{state.published ? rich(t("people.profile.publishedAt"), { link: <a href={state.published.url} target="_blank" rel="noopener noreferrer">{state.published.url}</a> }) : t("people.profile.private")}</p>
      <form class="people-form" onSubmit={(event) => { event.preventDefault(); if (draft && valid && editable && !stale) save.mutate(draft); }}>
        <label>{t("people.profile.displayName")}<input value={fields.displayName} maxLength={80} disabled={!editable} onInput={(event) => edit({ displayName: event.currentTarget.value })} /></label>
        <label>{t("people.profile.about")}<textarea value={fields.about} maxLength={2048} rows={4} disabled={!editable} onInput={(event) => edit({ about: event.currentTarget.value })} /></label>
        <label>{t("people.profile.policy")}<select value={fields.contactPolicy} disabled={!editable} onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === "requests" || value === "invitation" || value === "closed") edit({ contactPolicy: value });
        }}><option value="requests">{t("people.profile.policyRequests")}</option><option value="invitation">{t("people.profile.policyInvitation")}</option><option value="closed">{t("people.profile.policyClosed")}</option></select></label>
        <label class="people-profile-representation"><input type="checkbox" checked={fields.representation === "human-and-ship"} disabled={!editable} onChange={(event) => edit({ representation: event.currentTarget.checked ? "human-and-ship" : "human" })} />{t("people.profile.representation")}</label>
        <p class="people-note">{t("people.profile.representationHint")}</p>
        {stale && <p class="people-error">{t("people.profile.stale")}</p>}
        <div class="people-actions">
          <button class="ibtn" type="submit" disabled={!editable || !valid || !dirty || stale}>{save.isPending ? t("common.saving") : t("people.profile.saveDraft")}</button>
          {draft && <button class="people-action" type="button" disabled={pending} onClick={() => { setDraft(null); save.reset(); }}>{t("people.profile.discard")}</button>}
        </div>
      </form>
      <div class="people-profile-preview" aria-label={t("people.profile.preview")}>
        <p class="people-note">{t(dirty ? "people.profile.previewUnsaved" : "people.profile.previewSaved")}</p>
        <span class="people-profile-address">{state.url}</span><h2>{fields.displayName}</h2>
        {fields.about && <p class="people-profile-about">{fields.about}</p>}
        <p>{t(fields.contactPolicy === "requests" ? "people.profile.showsRequests" : fields.contactPolicy === "invitation" ? "people.profile.showsInvitation" : "people.profile.showsClosed")}</p>
        {fields.representation === "human-and-ship" && <p class="people-note">{t("people.profile.representationNote")}</p>}
      </div>
      <p class="people-note">{t(dirty ? "people.profile.saveFirst" : "people.profile.publishHint")}</p>
      <div class="people-actions">
        <button type="button" class="ibtn is-primary" disabled={!connected || pending || dirty || !valid || !state.revision || !canConfigure(account, "profile.publish") || state.published?.revision === state.revision} onClick={() => publish.mutate(state.revision)}>{t(publish.isPending ? "people.profile.publishing" : "people.profile.publish")}</button>
        {state.published && <button type="button" class="people-action is-danger" disabled={!connected || pending || !canConfigure(account, "profile.unpublish")} onClick={() => unpublish.mutate(state.revision)}>{t("people.profile.unpublish")}</button>}
      </div>
      <p class="people-note">{t("people.profile.unpublishHint")}</p>
    </>}
    </div></div>
  </section>;
}
