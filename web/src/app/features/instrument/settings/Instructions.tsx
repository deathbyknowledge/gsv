import { LoadingState } from "../../../components/ui/Spinner";
import { Select } from "../../../components/ui/Select";
import { TextArea } from "../../../components/ui/TextArea";
import { TextInput } from "../../../components/ui/TextInput";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useQuery } from "../../../services/navigation/viewQueries";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { canConfigure, newInstructionName, SETTINGS_INSTRUCTIONS_KEY } from "./settingsModel";
import { createInstruction, deleteInstruction, listInstructions, readInstruction, saveInstruction } from "./settingsService";
import { SettingsError, useSettingsDirty, type SettingsSectionProps } from "./settingsShared";
import { useT } from "../../../i18n/locale";
import { PageHeading } from "../../../components/ui/PageHeading";

type InstructionDraft = { original: string; content: string };

export function Instructions({ account, active, onDirty }: SettingsSectionProps) {
  const t = useT();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, InstructionDraft>>({});
  const [newDraft, setNewDraft] = useState<{ name: string; content: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleted, setDeleted] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const key = [...SETTINGS_INSTRUCTIONS_KEY, account.uid];
  const listKey = [...key, "list"];
  const canRead = canConfigure(account, "fs.read");
  const canWrite = canConfigure(account, "fs.write");
  const canDelete = canConfigure(account, "fs.delete");
  const files = useQuery({ queryKey: listKey, queryFn: () => listInstructions(client), enabled: connected && active && canRead });
  const name = selected ?? files.data?.[0] ?? null;
  const file = useQuery({ queryKey: [...key, "file", name], queryFn: () => readInstruction(client, name!), enabled: connected && active && canRead && name !== null && newDraft === null });
  const draft = name ? drafts[name] : undefined;
  const content = newDraft?.content ?? draft?.content ?? file.data;
  const newDirty = !!newDraft && (newDraft.name !== "" || newDraft.content !== "");
  const dirty = Object.values(drafts).some((entry) => entry.content !== entry.original) || newDirty;
  const forgetDraft = (fileName: string) => setDrafts((current) => {
    const next = { ...current };
    delete next[fileName];
    return next;
  });
  const save = useMutation({
    mutationFn: (input: { name: string; content: string }) => saveInstruction(client, input.name, input.content),
    onSuccess: async (_, input) => {
      await cache.cancelQueries({ queryKey: [...key, "file", input.name], exact: true });
      cache.setQueryData([...key, "file", input.name], input.content);
      forgetDraft(input.name);
      setSaved(input.name);
    },
  });
  const create = useMutation({
    mutationFn: (input: { name: string; content: string }) => createInstruction(client, input.name, input.content),
    onSuccess: async (createdName, input) => {
      await cache.cancelQueries({ queryKey: key });
      cache.setQueryData<string[]>(listKey, (current) => [...new Set([...(current ?? []), createdName])].sort());
      cache.setQueryData([...key, "file", createdName], input.content);
      forgetDraft(createdName);
      setSelected(createdName);
      setNewDraft(null);
      setSaved(createdName);
    },
    onError: async () => { await cache.invalidateQueries({ queryKey: listKey, exact: true }); },
  });
  const remove = useMutation({
    mutationFn: (fileName: string) => deleteInstruction(client, fileName),
    onSuccess: async (_, removedName) => {
      await cache.cancelQueries({ queryKey: key });
      const current = cache.getQueryData<string[]>(listKey) ?? [];
      const remaining = current.filter((entry) => entry !== removedName);
      cache.setQueryData(listKey, remaining);
      cache.removeQueries({ queryKey: [...key, "file", removedName], exact: true });
      forgetDraft(removedName);
      setSelected(remaining[Math.min(current.indexOf(removedName), remaining.length - 1)] ?? null);
      setConfirmDelete(false);
      setSaved(null);
      setDeleted(removedName);
    },
  });
  const pending = save.isPending || create.isPending || remove.isPending;
  useSettingsDirty(dirty || pending, onDirty);
  let newName: string | null = null;
  let nameError: string | null = null;
  if (newDraft?.name.trim()) {
    try {
      newName = newInstructionName(newDraft.name);
      if (files.data?.includes(newName)) nameError = t("settings.instructions.exists", { name: newName });
    } catch (error) { nameError = error instanceof Error ? error.message : t("settings.instructions.invalidName"); }
  }
  const editable = connected && canRead && canWrite && content !== undefined && !files.isError && !pending && !confirmDelete && (!!newDraft || !file.isError);
  const canCreate = editable && files.isSuccess && newName !== null && nameError === null;
  const currentError = save.variables?.name === name ? save.error : null;
  return <section aria-labelledby="settings-instructions-title">
    <PageHeading id="settings-instructions-title" title={t("settings.instructions.title")} description={t("settings.instructions.intro")} actions={!newDraft && canRead && canWrite && <button class="settings-text-action" type="button" disabled={!connected || !files.isSuccess || pending} onClick={() => {
      setNewDraft({ name: "", content: "" }); setConfirmDelete(false); setDeleted(null); setSaved(null); create.reset();
    }}>{t("settings.instructions.new")}</button>} />
    {!canRead && <p class="settings-muted">{t("settings.instructions.noRead")}</p>}
    {canRead && !canWrite && <p class="settings-muted">{t("settings.instructions.readOnly")}</p>}
    <SettingsError error={files.error} />
    {files.isPending && connected && canRead && <LoadingState variant="panel">{t("settings.instructions.loading")}</LoadingState>}
    {deleted && <p role="status">{t("settings.instructions.deleted", { name: deleted })}</p>}
    {!newDraft && files.data?.length === 0 && <p>{t("settings.instructions.none")}</p>}
    {!newDraft && files.data && files.data.length > 0 && <>
      <Select block label={t("settings.instructions.file")} options={files.data.map((entry) => ({ label: drafts[entry] && drafts[entry].content !== drafts[entry].original ? t("settings.instructions.unsavedFile", { name: entry }) : entry, value: entry }))} selected={name ?? ""} disabled={pending} onSelect={(value) => { setSelected(value); setConfirmDelete(false); setDeleted(null); setSaved(null); remove.reset(); }} />
      <SettingsError error={file.error ?? currentError ?? remove.error} />
      {file.isPending && connected && <LoadingState>{t("settings.instructions.reading")}</LoadingState>}
    </>}
    {newDraft && <div class="settings-instruction-heading">
      <h2>{t("settings.instructions.newTitle")}</h2>
      <button class="settings-text-action" type="button" disabled={pending} onClick={() => {
        if (!newDirty || window.confirm(t("settings.instructions.confirmDiscardNew"))) { setNewDraft(null); create.reset(); }
      }}>{t("common.cancel")}</button>
    </div>}
    {(newDraft || name) && <form class="settings-instruction-form" aria-label={t(newDraft ? "settings.instructions.newTitle" : "settings.instructions.edit")} onSubmit={(event) => {
      event.preventDefault();
      if (newDraft) { if (canCreate && newName) create.mutate({ name: newName, content: newDraft.content }); }
      else if (editable && name && content !== undefined) save.mutate({ name, content });
    }}>
      {newDraft && <>
        <TextInput label={t("settings.instructions.fileName")} description={t("settings.instructions.mdAdded")} placeholder={t("settings.instructions.namePlaceholder")} value={newDraft.name} readonly={!editable} status={nameError ? "error" : "none"} message={nameError ?? ""} inputProps={{ name: "instruction-name", autoFocus: true, autoComplete: "off" }} onChange={(value) => { setNewDraft({ ...newDraft, name: value }); create.reset(); }} />
        <SettingsError error={create.error} />
      </>}
      {content !== undefined && <>
        <TextArea label={newDraft ? t("settings.instructions.title") : name ?? ""} placeholder="" size="large" rows={24} value={content} readonly={!editable} textareaProps={{ "aria-label": t("settings.instructions.contentLabel") }} onChange={(value) => {
          if (newDraft) { setNewDraft({ ...newDraft, content: value }); create.reset(); }
          else if (name) { setDrafts({ ...drafts, [name]: { original: draft?.original ?? file.data!, content: value } }); save.reset(); }
          setSaved(null);
        }} />
        <div class="settings-actions">
          {newDraft ? <button class="ibtn" type="submit" disabled={!canCreate}>{create.isPending ? <LoadingState>{t("settings.instructions.creating")}</LoadingState> : t("settings.instructions.create")}</button>
            : <button class="ibtn" type="submit" disabled={!editable || !draft || draft.content === draft.original}>{save.isPending ? <LoadingState>{t("common.saving")}</LoadingState> : t("settings.instructions.save")}</button>}
          {!newDraft && name && draft && draft.content !== draft.original && <button class="settings-text-action" type="button" disabled={pending} onClick={() => { forgetDraft(name); save.reset(); }}>{t("common.discardChanges")}</button>}
          {!newDraft && saved === name && <span role="status">{t("common.saved")}</span>}
        </div>
      </>}
    </form>}
    {!newDraft && name && files.data?.includes(name) && canRead && canDelete && <div class="settings-instruction-removal">
      {confirmDelete ? <div role="group" aria-label={t("settings.instructions.deleteLabel", { name })}>
        <p>{t(draft && draft.content !== draft.original ? "settings.instructions.confirmDeleteUnsaved" : "settings.instructions.confirmDelete", { name })}</p>
        <div class="settings-actions">
          <button class="settings-text-action settings-danger" type="button" disabled={!connected || pending || files.isError} onClick={() => remove.mutate(name)}>{remove.isPending ? <LoadingState>{t("settings.instructions.deleting")}</LoadingState> : t("settings.instructions.delete")}</button>
          <button class="settings-text-action" type="button" disabled={pending} onClick={() => { setConfirmDelete(false); remove.reset(); }}>{t("common.cancel")}</button>
        </div>
      </div> : <button class="settings-text-action settings-danger" type="button" disabled={!connected || pending || files.isError} onClick={() => { setConfirmDelete(true); remove.reset(); }}>{t("common.delete")}</button>}
    </div>}
  </section>;
}
