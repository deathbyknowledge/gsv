import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { profileFieldsSchema, type ProfileFields, type ProfileState } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { loadProfile, saveProfile, publishProfile, unpublishProfile } from "../../../services/system/profileService";
import { LoadingState } from "../../../components/ui/Spinner";
import { INSTRUMENT_PROFILE_KEY } from "../wire/queryKeys";
import { canConfigure } from "./settingsModel";
import { SettingsError, useSettingsDirty, type SettingsSectionProps } from "./settingsShared";

export function Profile({ account, active, onDirty }: SettingsSectionProps) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const key = [...INSTRUMENT_PROFILE_KEY, account.uid];
  const [draft, setDraft] = useState<{ revision: number; fields: ProfileFields } | null>(null);
  const canRead = canConfigure(account, "profile.get");
  const profile = useQuery({ queryKey: key, queryFn: () => loadProfile(client), enabled: connected && active && canRead });
  const refresh = async (state: ProfileState) => {
    await cache.cancelQueries({ queryKey: key, exact: true });
    cache.setQueryData(key, state);
    await cache.invalidateQueries({ queryKey: key, exact: true });
  };
  const save = useMutation({
    mutationFn: (input: { revision: number; fields: ProfileFields }) => saveProfile(client, input.revision, input.fields),
    onSuccess: async (state) => { setDraft(null); await refresh(state); },
  });
  const publish = useMutation({ mutationFn: (revision: number) => publishProfile(client, revision), onSuccess: refresh });
  const unpublish = useMutation({
    mutationFn: (revision: number) => unpublishProfile(client, revision),
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
  useSettingsDirty(dirty || pending, onDirty);

  return <section aria-labelledby="settings-profile-title">
    <h1 id="settings-profile-title">Public profile</h1>
    <p class="settings-intro">Choose how people find you on GSV. Your profile starts private; publishing shares the preview below.</p>
    {!canRead && <p class="settings-muted">Your account cannot manage a public profile.</p>}
    <SettingsError error={profile.error ?? save.error ?? publish.error ?? unpublish.error} />
    {profile.isPending && connected && canRead && <LoadingState variant="panel">Loading your profile…</LoadingState>}
    {state && fields && <>
      <p role="status" class="settings-muted">{state.publicationFailed ? "Publication failed. Your previous published profile, if any, is still available. You can retry or unpublish."
        : state.publishing ? "Publication pending…" : state.published ? <>Published at <a href={state.published.url} target="_blank" rel="noopener noreferrer">{state.published.url}</a></> : "Your profile is private."}</p>
      <form class="settings-form" onSubmit={(event) => { event.preventDefault(); if (draft && valid && editable && !stale) save.mutate(draft); }}>
        <label>Public alias<input value={fields.alias} autoComplete="off" spellcheck={false} maxLength={32} disabled={!editable} onInput={(event) => edit({ alias: event.currentTarget.value })} /></label>
        <p class="settings-muted">2–32 lowercase letters, numbers, underscores or hyphens, starting with a letter. This is separate from your sign-in name. Previous aliases remain reserved to you.</p>
        <label>Display name<input value={fields.displayName} maxLength={80} disabled={!editable} onInput={(event) => edit({ displayName: event.currentTarget.value })} /></label>
        <label>About you<textarea value={fields.about} maxLength={2048} rows={4} disabled={!editable} onInput={(event) => edit({ about: event.currentTarget.value })} /></label>
        <label>New conversations<select value={fields.contactPolicy} disabled={!editable} onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === "requests" || value === "invitation" || value === "closed") edit({ contactPolicy: value });
        }}><option value="requests">Open to message requests</option><option value="invitation">By invitation</option><option value="closed">Closed</option></select></label>
        <label class="settings-check"><input type="checkbox" checked={fields.representation === "human-and-ship"} disabled={!editable} onChange={(event) => edit({ representation: event.currentTarget.checked ? "human-and-ship" : "human" })} />Let visitors know my Ship may reply</label>
        <p class="settings-muted">This describes your profile. Allowing your Ship to help is a separate choice.</p>
        {stale && <p class="settings-error">Your saved profile changed in another session. Reload the draft before saving.</p>}
        <div class="settings-actions">
          <button class="ibtn" type="submit" disabled={!editable || !valid || !dirty || stale}>{save.isPending ? "saving…" : "save draft"}</button>
          {draft && <button class="settings-text-action" type="button" disabled={pending} onClick={() => { setDraft(null); save.reset(); }}>discard edits</button>}
        </div>
      </form>
      <div class="settings-profile-preview" aria-label="Public profile preview">
        <p class="settings-muted">Preview · {dirty ? "unsaved edits" : "saved draft"}</p>
        <span class="settings-profile-alias">@{fields.alias || "your-alias"}</span><h2>{fields.displayName}</h2>
        {fields.about && <p class="settings-profile-about">{fields.about}</p>}
        <p>{fields.contactPolicy === "requests" ? "Open to message requests" : fields.contactPolicy === "invitation" ? "Connect by invitation" : "Not receiving new message requests"}</p>
        {fields.representation === "human-and-ship" && <p class="settings-muted">You may hear from this person or their Ship. Each message shows who sent it.</p>}
      </div>
      <p class="settings-muted">{dirty ? "Save your edits before publishing." : "Only the saved preview is published. Later draft edits stay private until you publish again."}</p>
      <div class="settings-actions">
        <button type="button" class="ibtn is-primary" disabled={!connected || pending || dirty || !valid || !state.revision || !canConfigure(account, "profile.publish") || (state.publishing && !state.publicationFailed) || state.published?.revision === state.revision} onClick={() => publish.mutate(state.revision)}>{publish.isPending ? "publishing…" : state.publicationFailed ? "retry publication" : "publish profile"}</button>
        {(state.published || state.publishing) && <button type="button" class="settings-text-action is-danger" disabled={!connected || pending || !canConfigure(account, "profile.unpublish")} onClick={() => unpublish.mutate(state.revision)}>unpublish</button>}
      </div>
      <p class="settings-muted">Unpublishing removes your public page. People may retain copies they already viewed. Existing conversations continue.</p>
    </>}
  </section>;
}
