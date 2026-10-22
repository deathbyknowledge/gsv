import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { profileFieldsSchema, type ProfileFields, type ProfileState } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { LoadingState } from "../../../components/ui/Spinner";
import { INSTRUMENT_PROFILE_KEY } from "../wire/queryKeys";
import { canConfigure } from "../settings/settingsModel";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { rich, useT } from "../../../i18n/locale";
import { Button } from "../../../components/ui/Button";
import { Checkbox } from "../../../components/ui/Checkbox";
import { IconButton } from "../../../components/ui/IconButton";
import { InfoTip } from "../../../components/ui/InfoTip";
import { Select } from "../../../components/ui/Select";
import { Tag } from "../../../components/ui/Tag";
import { TextArea } from "../../../components/ui/TextArea";
import { Hint } from "../../../components/ui/Tooltip";

export function Profile({ account, active, edit: editing, focusBio, onDirty, onEdit, onBack }: {
  account: ConsoleAccount; active: boolean; edit: boolean; focusBio: boolean; onDirty: (dirty: boolean) => void;
  onEdit: (focus?: "bio") => void; onBack: () => void;
}) {
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
  const publish = useMutation({
    mutationFn: async (input: { revision: number; fields: ProfileFields | null }) => {
      let revision = input.revision;
      if (input.fields) {
        // Commit the saved draft before publishing: if publishing fails, the edit stays saved as
        // unpublished changes and save can retry, instead of leaving a stale local draft.
        const saved = (await client.profile.update({ expectedRevision: input.revision, draft: input.fields })).profile;
        setDraft(null);
        await refresh(saved);
        revision = saved.revision;
      }
      return (await client.profile.publish({ expectedRevision: revision })).profile;
    },
    onSuccess: async (state) => { setDraft(null); await refresh(state); onBack(); },
  });
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
  const canPublish = canConfigure(account, "profile.publish");
  // The saved draft is what visitors see.
  const live = !!state?.published && state.published.revision === state.revision;
  useLayoutEffect(() => { onDirty(dirty || pending); }, [dirty, pending, onDirty]);
  const error = profile.error ?? save.error ?? publish.error ?? unpublish.error;
  const bio = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  // The note under the save buttons explains whichever one is hovered or focused.
  const [saveNote, setSaveNote] = useState<"save" | "draft" | null>(null);
  const noteFor = (which: "save" | "draft") => ({
    onPointerEnter: () => setSaveNote(which), onPointerLeave: () => setSaveNote(null),
    onFocusIn: () => setSaveNote(which), onFocusOut: () => setSaveNote(null),
  });
  useEffect(() => { if (editing && focusBio && state) bio.current?.focus(); }, [editing, focusBio, !!state]);
  useEffect(() => { setCopied(null); }, [editing]);

  // The recorded handle is the profile's name; saving publishes it even when an older draft carried another.
  // Without a recorded handle, the profile keeps the name it already has.
  const named = (shown: ProfileFields): ProfileFields => ({
    ...shown,
    ...(state?.handle ? { displayName: state.handle } : undefined),
    // The Kernel enforces "closed" exactly like "invitation"; save the option the editor shows.
    ...(shown.contactPolicy === "closed" ? { contactPolicy: "invitation" as const } : undefined),
  });
  const title = state ? (state.handle ? `@${state.handle}` : state.draft.displayName) : "";
  // A stored name that predates the handle still needs saving, even without other edits.
  const renamePending = !!state?.handle && state.draft.displayName !== state.handle;
  const policyLabel = (policy: ProfileFields["contactPolicy"]) => t(policy === "requests" ? "people.profile.policyRequests" : "people.profile.policyInvitation");
  const status = state && <p role="status" class="people-note">{state.published ? rich(t("people.profile.publishedAt"), { link: <a href={state.published.url} target="_blank" rel="noopener noreferrer">{state.published.url}</a> }) : t("people.profile.private")}</p>;
  const copyAddress = state && <span class="people-profile-handle">
    <h2>{title}</h2>
    <Hint text={t("people.profile.copyAddress")}>
      <IconButton glyph="copy" ghost size="small" ariaLabel={t("people.profile.copyAddress")} onClick={() => {
        void navigator.clipboard.writeText(state.url).then(() => setCopied("copied"), () => setCopied("failed"));
      }} />
    </Hint>
    <span class="people-note" role="status">{copied === "copied" ? t("shell.copied") : copied === "failed" ? t("people.profile.copyFailed") : ""}</span>
  </span>;
  const preview = (shown: ProfileFields, note: string | null) => state && <div class="people-profile-preview" aria-label={t("people.profile.preview")}>
    {note && <p class="people-note">{note}</p>}
    {copyAddress}
    {shown.about ? <p class="people-profile-about">{shown.about}</p>
      : <p class="people-profile-about is-empty">{t("people.profile.emptyBio")}{" "}
        {!editing && <span class="people-profile-complete"><Button variant="link" label={t("people.profile.completeBio")} disabled={!connected || !canConfigure(account, "profile.update")} onClick={() => onEdit("bio")} /></span>}</p>}
    <p class="people-profile-policy">{policyLabel(shown.contactPolicy)}</p>
    {shown.representation === "human-and-ship" && <p class="people-note">{t("people.profile.representationNote")}</p>}
  </div>;
  const unpublishedChanges = !!state?.published && state.published.revision !== state.revision;

  return <section class="people-profile" aria-labelledby="people-profile-title">
    <header class="people-conversation-header">
      <span class="people-conversation-back"><IconButton glyph="arrowBack" ghost size={32} ariaLabel={t("people.back.label")} onClick={onBack} /></span>
      <div class="people-conversation-title people-profile-title">
        <h1 id="people-profile-title">{t(editing ? "people.profile.editTitle" : "people.profile.title")}</h1>
        {state && !editing && <>
          <span class="people-profile-tag"><Tag boxed size="medium" tone={state.published ? "accent" : "idle"} label={t(state.published ? "people.profile.publicLabel" : "people.profile.privateLabel")} /></span>
          {unpublishedChanges && <span class="people-profile-tag"><Tag boxed size="medium" tone="update" label={t("people.profile.unpublishedChanges")} /></span>}
          <InfoTip position="bottom" label={t("people.profile.visibilityQuestion")} title={t("people.profile.visibilityQuestion")} text={t(!state.published ? "people.profile.visibilityPrivate" : state.draft.contactPolicy === "requests" ? "people.profile.visibilityPublic" : "people.profile.visibilityPublicInvite")} />
        </>}
      </div>
      {state && !editing && <span class="people-profile-edit"><Button variant="link" label={`${t("people.profile.edit")}${dirty ? " ·" : ""}`} disabled={!connected || !canConfigure(account, "profile.update")} onClick={() => onEdit()} /></span>}
    </header>
    <div class="people-profile-scroll" data-scroll-edge><div class="people-own-profile">
    {editing && <p class="people-note">{t("people.profile.intro")}</p>}
    {!canRead && <p class="people-note">{t("people.profile.noAccess")}</p>}
    {error && <p class="people-error" role="alert">{error.message}</p>}
    {profile.isPending && connected && canRead && <LoadingState variant="panel">{t("people.profile.loading")}</LoadingState>}
    {state && !editing && preview(state.draft, unpublishedChanges ? t("people.profile.previewSaved") : null)}
    {state && fields && editing && <>
      {status}
      <form class="people-form" onSubmit={(event) => {
        event.preventDefault();
        if (valid && editable && canPublish && !stale && (draft || !live || renamePending)) {
          publish.mutate({ revision: draft?.revision ?? state.revision, fields: draft ? named(draft.fields) : renamePending ? named(state.draft) : null });
        }
      }}>
        <TextArea label={t("people.profile.about")} value={fields.about} maxLength={2048} rows={4} disabled={!editable} placeholder={t("people.profile.emptyBio")}
          onChange={(about) => edit({ about })} textareaProps={{ ref: bio }} />
        <Select block label={t("people.profile.policy")} disabled={!editable}
          options={[{ value: "requests", label: t("people.profile.policyRequests") }, { value: "invitation", label: t("people.profile.policyInvitation") }]}
          value={fields.contactPolicy === "requests" ? 0 : 1} onChange={(index) => edit({ contactPolicy: index === 0 ? "requests" : "invitation" })} />
        <Checkbox checked={fields.representation === "human-and-ship"} disabled={!editable} label={t("people.profile.representation")} info={t("people.profile.representationHint")}
          onChange={(checked) => edit({ representation: checked ? "human-and-ship" : "human" })} />
        {stale && <p class="people-error">{t("people.profile.stale")}</p>}
        <div class="people-actions">
          <span {...noteFor("save")}>
            <Button type="submit" variant="primary" aria-describedby="people-profile-save-note" disabled={!editable || !canPublish || !valid || stale || (!dirty && live && !renamePending)} label={publish.isPending ? t("common.saving") : t("people.profile.save")} />
          </span>
          <span {...noteFor("draft")}>
            <Button variant="secondary" aria-describedby="people-profile-save-note" disabled={!editable || !valid || !dirty || stale} label={save.isPending ? t("common.saving") : t("people.profile.saveDraft")} onClick={() => { if (draft) save.mutate({ ...draft, fields: named(draft.fields) }); }} />
          </span>
          {draft && <Button variant="link" tone="neutral" disabled={pending} label={t("people.profile.discard")} onClick={() => { setDraft(null); save.reset(); }} />}
        </div>
        <p id="people-profile-save-note" class="people-note people-profile-save-note" aria-live="polite">{saveNote && t(saveNote === "save" ? "people.profile.saveTip" : "people.profile.saveDraftTip")}</p>
      </form>
      {preview(fields, t(dirty ? "people.profile.previewUnsaved" : "people.profile.previewSaved"))}
      {state.published && <div class="people-actions">
        <Button variant="dangerGhost" disabled={!connected || pending || !canConfigure(account, "profile.unpublish")} label={t("people.profile.unpublish")} onClick={() => unpublish.mutate(state.revision)} />
      </div>}
      {state.published && <p class="people-note">{t("people.profile.unpublishHint")}</p>}
    </>}
    </div></div>
  </section>;
}
