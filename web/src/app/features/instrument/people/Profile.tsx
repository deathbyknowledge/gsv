import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useLayoutEffect, useState } from "preact/hooks";
import { profileFieldsSchema, type ProfileFields, type ProfileState } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { LoadingState } from "../../../components/ui/Spinner";
import { INSTRUMENT_PROFILE_KEY } from "../wire/queryKeys";
import { canConfigure } from "../settings/settingsModel";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";

export function Profile({ account, active, onDirty }: { account: ConsoleAccount; active: boolean; onDirty: (dirty: boolean) => void }) {
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

  return <section class="people-own-profile" aria-labelledby="people-profile-title">
    <h1 id="people-profile-title">Your profile</h1>
    <p class="people-note">Choose what people see when they visit your space.</p>
    {!canRead && <p class="people-note">Your account cannot manage a public profile.</p>}
    {error && <p class="people-error" role="alert">{error.message}</p>}
    {profile.isPending && connected && canRead && <LoadingState variant="panel">Loading your profile…</LoadingState>}
    {state && fields && <>
      <p role="status" class="people-note">{state.published ? <>Published at <a href={state.published.url} target="_blank" rel="noopener noreferrer">{state.published.url}</a></> : "Your profile is private."}</p>
      <form class="people-form" onSubmit={(event) => { event.preventDefault(); if (draft && valid && editable && !stale) save.mutate(draft); }}>
        <label>Display name<input value={fields.displayName} maxLength={80} disabled={!editable} onInput={(event) => edit({ displayName: event.currentTarget.value })} /></label>
        <label>About you<textarea value={fields.about} maxLength={2048} rows={4} disabled={!editable} onInput={(event) => edit({ about: event.currentTarget.value })} /></label>
        <label>New conversations<select value={fields.contactPolicy} disabled={!editable} onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === "requests" || value === "invitation" || value === "closed") edit({ contactPolicy: value });
        }}><option value="requests">Open to message requests</option><option value="invitation">By invitation</option><option value="closed">Closed</option></select></label>
        <label class="people-profile-representation"><input type="checkbox" checked={fields.representation === "human-and-ship"} disabled={!editable} onChange={(event) => edit({ representation: event.currentTarget.checked ? "human-and-ship" : "human" })} />Let visitors know my Ship may reply</label>
        <p class="people-note">This describes your profile. Allowing your Ship to help is a separate choice.</p>
        {stale && <p class="people-error">Your saved profile changed in another session. Reload the draft before saving.</p>}
        <div class="people-actions">
          <button class="ibtn" type="submit" disabled={!editable || !valid || !dirty || stale}>{save.isPending ? "saving…" : "save draft"}</button>
          {draft && <button class="people-action" type="button" disabled={pending} onClick={() => { setDraft(null); save.reset(); }}>discard edits</button>}
        </div>
      </form>
      <div class="people-profile-preview" aria-label="Public profile preview">
        <p class="people-note">Preview · {dirty ? "unsaved edits" : "saved draft"}</p>
        <span class="people-profile-address">{state.url}</span><h2>{fields.displayName}</h2>
        {fields.about && <p class="people-profile-about">{fields.about}</p>}
        <p>{fields.contactPolicy === "requests" ? "Open to message requests" : fields.contactPolicy === "invitation" ? "Connect by invitation" : "Not receiving new message requests"}</p>
        {fields.representation === "human-and-ship" && <p class="people-note">You may hear from this person or their Ship. Each message shows who sent it.</p>}
      </div>
      <p class="people-note">{dirty ? "Save your edits before publishing." : "Only the saved preview is published. Later draft edits stay private until you publish again."}</p>
      <div class="people-actions">
        <button type="button" class="ibtn is-primary" disabled={!connected || pending || dirty || !valid || !state.revision || !canConfigure(account, "profile.publish") || state.published?.revision === state.revision} onClick={() => publish.mutate(state.revision)}>{publish.isPending ? "publishing…" : "publish profile"}</button>
        {state.published && <button type="button" class="people-action is-danger" disabled={!connected || pending || !canConfigure(account, "profile.unpublish")} onClick={() => unpublish.mutate(state.revision)}>unpublish</button>}
      </div>
      <p class="people-note">Unpublishing removes your public page. People may retain copies they already viewed. Existing conversations continue.</p>
    </>}
  </section>;
}
