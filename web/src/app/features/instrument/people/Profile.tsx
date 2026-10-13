import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useLayoutEffect, useState } from "preact/hooks";
import { profileFieldsSchema, type ProfileFields, type ProfileState } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { AuthShip } from "../../session/backgrounds/AuthShip";
import { useColorTheme } from "../../../components/ui/useColorTheme";
import { LoadingState } from "../../../components/ui/Spinner";
import { INSTRUMENT_PROFILE_KEY } from "../wire/queryKeys";
import { canConfigure } from "../settings/settingsModel";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";

export function Profile({ account, active, onDirty }: { account: ConsoleAccount; active: boolean; onDirty: (dirty: boolean) => void }) {
  const { client, connected } = useGateway();
  const { theme } = useColorTheme();
  const [preview, setPreview] = useState(false);
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
  const saved = state?.draft;
  let fields = draft?.fields ?? saved;
  if (!draft && fields && !fields.ship && state?.shipAccount) {
    fields = { ...fields, ship: { displayName: state.shipAccount.displayName, about: "" } };
  }
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
    <header class="people-profile-heading">
      <div><p class="people-kicker">YOUR SPACE</p><h1 id="people-profile-title">You & your Ship</h1></div>
      <div class="people-profile-mode" aria-label="Profile view">
        <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>edit</button>
        <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>preview</button>
      </div>
    </header>
    {!canRead && <p class="people-note">Your account cannot manage a public profile.</p>}
    {error && <p class="people-error" role="alert">{error.message}</p>}
    {profile.isPending && connected && canRead && <LoadingState variant="panel">Loading your profile…</LoadingState>}
    {state && fields && <>
      <div class="people-profile-publication">
        <span class={`people-profile-status${state.published ? " is-published" : ""}`}>{state.published ? "Published" : "Private"}</span>
        <a href={state.url} target="_blank" rel="noopener noreferrer" class="people-profile-address">{new URL(state.url).host}/profile ↗</a>
      </div>
      <form class="people-profile-form" onSubmit={(event) => { event.preventDefault(); if (draft && valid && editable && !stale) save.mutate(draft); }}>
        <section class="people-profile-person" aria-label="Your identity">
          <div class="people-profile-monogram" aria-hidden="true">{Array.from(fields.displayName.trim())[0]?.toLocaleUpperCase() || "·"}</div>
          <div class="people-profile-person-details">
            <p class="people-kicker">THE PERSON</p>
            {preview ? <><h2>{fields.displayName}</h2>{fields.about && <p class="people-profile-prose">{fields.about}</p>}</> : <>
              <label>Your name<input value={fields.displayName} maxLength={80} disabled={!editable || !canConfigure(account, "account.update")} onInput={(event) => edit({ displayName: event.currentTarget.value })} /></label>
              <label>About you<textarea value={fields.about} maxLength={2048} rows={3} placeholder="A little about you, and what you’re here for." disabled={!editable} onInput={(event) => edit({ about: event.currentTarget.value })} /></label>
            </>}
          </div>
        </section>
        {fields.ship && (!preview || fields.representation === "human-and-ship") && <section class="people-profile-ship" aria-label="Your Ship identity">
          <div class="people-profile-ship-art"><AuthShip theme={theme} compact /></div>
          <div class="people-profile-ship-details">
            <p class="people-kicker">{preview ? `${fields.displayName}’S SHIP` : "YOUR SHIP"}</p>
            {preview ? <><h2>{fields.ship.displayName}</h2>{fields.ship.about && <p class="people-profile-prose">{fields.ship.about}</p>}</> : <>
              <label>Ship name<input value={fields.ship.displayName} maxLength={80} disabled={!editable || !canConfigure(account, "account.update")} onInput={(event) => edit({ ship: { ...fields.ship!, displayName: event.currentTarget.value } })} /></label>
              <label>Introduction<textarea value={fields.ship.about} maxLength={2048} rows={3} placeholder="Introduce your Ship to the people you meet." disabled={!editable} onInput={(event) => edit({ ship: { ...fields.ship!, about: event.currentTarget.value } })} /></label>
            </>}
          </div>
        </section>}
        {!preview ? <>
          <div class="people-profile-sharing">
            <div><p class="people-kicker">WHEN PEOPLE VISIT</p><p class="people-note">Choose how your space welcomes people.</p></div>
            <div class="people-profile-sharing-controls">
              <label>New conversations<select value={fields.contactPolicy} disabled={!editable} onChange={(event) => {
                const value = event.currentTarget.value;
                if (value === "requests" || value === "invitation" || value === "closed") edit({ contactPolicy: value });
              }}><option value="requests">Open to message requests</option><option value="invitation">By invitation</option><option value="closed">Closed</option></select></label>
              <label class="people-profile-representation"><input type="checkbox" checked={fields.representation === "human-and-ship"} disabled={!editable} onChange={(event) => edit({ representation: event.currentTarget.checked ? "human-and-ship" : "human" })} />Show my Ship on my public profile</label>
              <p class="people-note">You choose who handles messages in each conversation.</p>
            </div>
          </div>
          {stale && <p class="people-error">Your profile changed in another session. Discard your edits to load the latest version.</p>}
          <div class="people-profile-save">
            <p class="people-note">Names update in conversations when you save. Your public page changes when you publish.</p>
            <div class="people-actions"><button class="ibtn" type="submit" disabled={!editable || !valid || !dirty || stale}>{save.isPending ? "saving…" : "save changes"}</button>
              {draft && <button class="people-action" type="button" disabled={pending} onClick={() => { setDraft(null); save.reset(); }}>discard edits</button>}
            </div>
          </div>
        </> : <div class="people-profile-preview-policy">
          <span>{fields.contactPolicy === "requests" ? "Open to message requests" : fields.contactPolicy === "invitation" ? "Connect by invitation" : "Not receiving new message requests"}</span>
          {fields.representation === "human-and-ship" && <p class="people-note">Messages show whether you’re hearing from {fields.displayName} or their Ship.</p>}
        </div>}
      </form>
      <footer class="people-profile-publish">
        <p class="people-note">{dirty ? "Save your changes before publishing." : state.published?.revision === state.revision ? "Your public page is up to date." : state.published ? "You have changes ready to publish." : "Your profile is visible only to you until you publish."}</p>
        <div class="people-actions">
          <button type="button" class="ibtn is-primary" disabled={!connected || pending || dirty || !valid || !state.revision || !canConfigure(account, "profile.publish") || state.published?.revision === state.revision} onClick={() => publish.mutate(state.revision)}>{publish.isPending ? "publishing…" : state.published ? "publish changes" : "publish profile"}</button>
          {state.published && <button type="button" class="people-action is-danger" disabled={!connected || pending || !canConfigure(account, "profile.unpublish")} onClick={() => unpublish.mutate(state.revision)}>unpublish</button>}
        </div>
      </footer>
    </>}
  </section>;
}
