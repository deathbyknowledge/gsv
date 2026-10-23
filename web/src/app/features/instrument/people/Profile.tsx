import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { profileFieldsSchema, type ProfileFields, type ProfileState } from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { LoadingState } from "../../../components/ui/Spinner";
import { INSTRUMENT_PROFILE_KEY } from "../wire/queryKeys";
import { canConfigure } from "../settings/settingsModel";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { rich, useT } from "../../../i18n/locale";
import { Button } from "../../../components/ui/Button";
import { IconButton } from "../../../components/ui/IconButton";
import { InfoTip } from "../../../components/ui/InfoTip";
import { Select } from "../../../components/ui/Select";
import { Tag } from "../../../components/ui/Tag";
import { TextArea } from "../../../components/ui/TextArea";
import { Hint } from "../../../components/ui/Tooltip";
import { profileNamed, profileSubmission, profileUnpublished, profileVisibility, type ProfilePictureEdit, type ProfileSubmission } from "./profileModel";
import { profilePicture, readProfilePicture, saveProfilePicture } from "./profilePicture";
import { ProfilePicturePicker, useObjectUrl } from "./ProfilePicturePicker";
import { ProfileNotice } from "./ProfileNotice";

const VISIBILITY_TEXT = {
  private: "people.profile.visibilityPrivate", requests: "people.profile.visibilityPublic", invitation: "people.profile.visibilityPublicInvite",
} as const;

export function Profile({ account, active, edit: editing, focusBio, onDirty, onEdit, onBack }: {
  account: ConsoleAccount; active: boolean; edit: boolean; focusBio: boolean; onDirty: (dirty: boolean) => void;
  onEdit: (focus?: "bio") => void; onBack: () => void;
}) {
  const t = useT();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const key = [...INSTRUMENT_PROFILE_KEY, account.uid];
  const [draft, setDraft] = useState<{ revision: number; fields: ProfileFields } | null>(null);
  const [pictureEdit, setPictureEdit] = useState<ProfilePictureEdit | null>(null);
  const [pictureError, setPictureError] = useState<string | null>(null);
  const canRead = canConfigure(account, "profile.get");
  const profile = useQuery({ queryKey: key, queryFn: async () => (await client.profile.get({})).profile, enabled: connected && active && canRead });
  const savedAvatar = profile.data?.avatar;
  // A picture is named by its CID, so its bytes never change and profile updates don't refetch it.
  const savedPicture = useQuery({
    queryKey: ["instrument", "profile-picture", account.uid, savedAvatar?.cid ?? null],
    queryFn: async () => await readProfilePicture(client, savedAvatar!),
    enabled: connected && active && !!savedAvatar,
    staleTime: Infinity,
  });
  const savedPictureUrl = useObjectUrl(savedAvatar ? savedPicture.data ?? null : null);
  const chosenPicture = useMemo(() => pictureEdit?.picture ? new Blob([pictureEdit.picture.bytes.slice()], { type: pictureEdit.picture.mimeType }) : null, [pictureEdit]);
  const chosenPictureUrl = useObjectUrl(chosenPicture);
  const refresh = async (state: ProfileState) => {
    await cache.cancelQueries({ queryKey: key, exact: true });
    cache.setQueryData(key, state);
    await cache.invalidateQueries({ queryKey: key, exact: true });
  };
  /** Saves the chosen picture first; edits still in the editor move to the revision it leaves. */
  const savePicture = async (revision: number, edit: ProfilePictureEdit): Promise<number> => {
    const saved = await saveProfilePicture(client, revision, edit.picture);
    setPictureEdit(null);
    setDraft((current) => current?.revision === revision ? { ...current, revision: saved.revision } : current);
    await refresh(saved);
    return saved.revision;
  };
  const save = useMutation({
    mutationFn: async (input: { revision: number; fields: ProfileFields | null; picture: ProfilePictureEdit | null }) => {
      const revision = input.picture ? await savePicture(input.revision, input.picture) : input.revision;
      return input.fields ? (await client.profile.update({ expectedRevision: revision, draft: input.fields })).profile : null;
    },
    onSuccess: async (state) => { setDraft(null); if (state) await refresh(state); },
  });
  const publish = useMutation({
    mutationFn: async (input: ProfileSubmission) => {
      let revision = input.picture ? await savePicture(input.revision, input.picture) : input.revision;
      if (input.fields) {
        // Commit the saved draft before publishing: if publishing fails, the edit stays saved as
        // unpublished changes and save can retry, instead of leaving a stale local draft.
        const saved = (await client.profile.update({ expectedRevision: revision, draft: input.fields })).profile;
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
      setPictureEdit((current) => current?.revision === revision ? { ...current, revision: state.revision } : current);
      await refresh(state);
    },
  });
  const pending = save.isPending || publish.isPending || unpublish.isPending;
  const state = profile.data;
  const fields = draft?.fields ?? state?.draft;
  const dirty = draft !== null || pictureEdit !== null;
  const stale = !!state && ((!!draft && draft.revision !== state.revision) || (!!pictureEdit && pictureEdit.revision !== state.revision));
  const valid = !!fields && !!fields.displayName.trim() && profileFieldsSchema.safeParse(fields).success;
  const edit = (patch: Partial<ProfileFields>) => {
    if (!state || !fields) return;
    setDraft({ revision: draft?.revision ?? state.revision, fields: { ...fields, ...patch } });
  };
  const choosePicture = (file: File) => {
    if (!state) return;
    setPictureError(null);
    void profilePicture(file).then(
      (picture) => setPictureEdit({ revision: pictureEdit?.revision ?? draft?.revision ?? state.revision, picture }),
      (cause: unknown) => setPictureError(cause instanceof Error ? cause.message : t("people.profile.pictureUnreadable")),
    );
  };
  const removePicture = () => {
    if (!state) return;
    setPictureError(null);
    // A picture chosen in the editor and removed again leaves nothing to save.
    setPictureEdit(state.avatar ? { revision: pictureEdit?.revision ?? draft?.revision ?? state.revision, picture: null } : null);
  };
  const shownPictureUrl = pictureEdit ? chosenPictureUrl : savedPictureUrl;
  const editable = connected && canConfigure(account, "profile.update") && !pending;
  const canPublish = canConfigure(account, "profile.publish");
  const submission = state ? profileSubmission(state, draft, pictureEdit) : null;
  useLayoutEffect(() => { onDirty(dirty || pending); }, [dirty, pending, onDirty]);
  const error = profile.error ?? save.error ?? publish.error ?? unpublish.error;
  const bio = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  useEffect(() => { if (editing && focusBio && state) bio.current?.focus(); }, [editing, focusBio, !!state]);
  useEffect(() => { setCopied(null); }, [editing]);

  const title = state ? (state.handle ? `@${state.handle}` : state.draft.displayName) : "";
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
  const preview = (shown: ProfileFields, note: string | null, pictureUrl: string | null) => state && <div class="people-profile-preview" aria-label={t("people.profile.preview")}>
    {note && <p class="people-note">{note}</p>}
    {pictureUrl && <img class="people-picture-image" src={pictureUrl} alt={t("people.profile.pictureAlt")} width={96} height={96} />}
    {copyAddress}
    {shown.about ? <p class="people-profile-about">{shown.about}</p>
      : <p class="people-profile-about is-empty">{t("people.profile.emptyBio")}{" "}
        {!editing && <span class="people-profile-complete"><Button variant="link" label={t("people.profile.completeBio")} disabled={!connected || !canConfigure(account, "profile.update")} onClick={() => onEdit("bio")} /></span>}</p>}
    <p class="people-profile-policy">{policyLabel(shown.contactPolicy)}</p>
  </div>;
  const unpublishedChanges = !!state && profileUnpublished(state);

  return <section class="people-profile" aria-labelledby="people-profile-title">
    <header class="people-conversation-header">
      <span class="people-conversation-back"><IconButton glyph="arrowBack" ghost size={32} ariaLabel={t("people.back.label")} onClick={onBack} /></span>
      <div class="people-conversation-title people-profile-title">
        <h1 id="people-profile-title">{t(editing ? "people.profile.editTitle" : "people.profile.title")}</h1>
        {state && !editing && <>
          <span class="people-profile-tag"><Tag boxed size="medium" tone={state.published ? "accent" : "idle"} label={t(state.published ? "people.profile.publicLabel" : "people.profile.privateLabel")} /></span>
          {unpublishedChanges && <span class="people-profile-tag"><Tag boxed size="medium" tone="update" label={t("people.profile.unpublishedChanges")} /></span>}
          <InfoTip position="bottom" label={t("people.profile.visibilityQuestion")} title={t("people.profile.visibilityQuestion")} text={t(VISIBILITY_TEXT[profileVisibility(state)])} />
        </>}
      </div>
      {state && !editing && <span class="people-profile-edit"><Button variant="link" label={`${t("people.profile.edit")}${dirty ? " ·" : ""}`} disabled={!connected || !canConfigure(account, "profile.update")} onClick={() => onEdit()} /></span>}
    </header>
    <div class="people-profile-scroll" data-scroll-edge><div class="people-own-profile">
    {editing && <p class="people-note">{t("people.profile.intro")}</p>}
    {!canRead && <p class="people-note">{t("people.profile.noAccess")}</p>}
    {error && <p class="people-error" role="alert">{error.message}</p>}
    {profile.isPending && connected && canRead && <LoadingState variant="panel">{t("people.profile.loading")}</LoadingState>}
    {state && !editing && <ProfileNotice ownerUid={account.uid} published={!!state.published} />}
    {state && !editing && preview(state.draft, unpublishedChanges ? t("people.profile.previewSaved") : null, savedPictureUrl)}
    {state && fields && editing && <>
      {status}
      <form class="people-form" onSubmit={(event) => {
        event.preventDefault();
        if (valid && editable && canPublish && submission?.ready) publish.mutate(submission);
      }}>
        <ProfilePicturePicker src={shownPictureUrl} disabled={!editable} error={pictureError ?? savedPicture.error?.message ?? null}
          onChoose={choosePicture} onRemove={removePicture} />
        <TextArea label={t("people.profile.about")} value={fields.about} maxLength={2048} rows={4} disabled={!editable} placeholder={t("people.profile.emptyBio")}
          onChange={(about) => edit({ about })} textareaProps={{ ref: bio }} />
        <Select block label={t("people.profile.policy")} disabled={!editable}
          options={[{ value: "requests", label: t("people.profile.policyRequests") }, { value: "invitation", label: t("people.profile.policyInvitation") }]}
          value={fields.contactPolicy === "requests" ? 0 : 1} onChange={(index) => edit({ contactPolicy: index === 0 ? "requests" : "invitation" })} />
        {stale && <p class="people-error">{t("people.profile.stale")}</p>}
        <div class="people-actions">
          <Button type="submit" variant="primary" aria-describedby="people-profile-save-note" disabled={!editable || !canPublish || !valid || !submission?.ready} label={publish.isPending ? t("common.saving") : t(submission?.action === "publish" ? "people.profile.publish" : "people.profile.save")} />
          <Button variant="secondary" aria-describedby="people-profile-save-note" disabled={!editable || !valid || !dirty || stale} label={save.isPending ? t("common.saving") : t("people.profile.saveDraft")} onClick={() => {
            save.mutate({ revision: draft?.revision ?? pictureEdit?.revision ?? state.revision, fields: draft ? profileNamed(state, draft.fields) : null, picture: pictureEdit });
          }} />
          {dirty && <Button variant="link" tone="neutral" disabled={pending} label={t("people.profile.discard")} onClick={() => { setDraft(null); setPictureEdit(null); setPictureError(null); save.reset(); }} />}
        </div>
        <p id="people-profile-save-note" class="people-note people-profile-save-note">{t(state.published ? "people.profile.saveNote" : "people.profile.publishNote")}</p>
      </form>
      {preview(fields, t(dirty ? "people.profile.previewUnsaved" : "people.profile.previewSaved"), shownPictureUrl)}
      {state.published && <div class="people-actions">
        <Button variant="dangerGhost" disabled={!connected || pending || !canConfigure(account, "profile.unpublish")} label={t("people.profile.unpublish")} onClick={() => unpublish.mutate(state.revision)} />
      </div>}
      {state.published && <p class="people-note">{t("people.profile.unpublishHint")}</p>}
    </>}
    </div></div>
  </section>;
}
