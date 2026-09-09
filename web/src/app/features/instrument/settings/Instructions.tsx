import { LoadingState } from "../../../components/ui/Spinner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { canConfigure, newInstructionName, SETTINGS_INSTRUCTIONS_KEY } from "./settingsModel";
import { createInstruction, deleteInstruction, listInstructions, readInstruction, saveInstruction } from "./settingsService";
import { SettingsError, useSettingsDirty, type SettingsSectionProps } from "./settingsShared";

type InstructionDraft = { original: string; content: string };

export function Instructions({ account, active, onDirty }: SettingsSectionProps) {
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
      if (files.data?.includes(newName)) nameError = `“${newName}” already exists. Choose a different name.`;
    } catch (error) { nameError = error instanceof Error ? error.message : "Use a valid file name"; }
  }
  const editable = connected && canRead && canWrite && content !== undefined && !files.isError && !pending && !confirmDelete && (!!newDraft || !file.isError);
  const canCreate = editable && files.isSuccess && newName !== null && nameError === null;
  const currentError = save.variables?.name === name ? save.error : null;
  return <section aria-labelledby="settings-instructions-title">
    <div class="settings-instruction-heading">
      <h1 id="settings-instructions-title">Instructions</h1>
      {!newDraft && canRead && canWrite && <button class="settings-text-action" type="button" disabled={!connected || !files.isSuccess || pending} onClick={() => {
        setNewDraft({ name: "", content: "" }); setConfirmDelete(false); setDeleted(null); setSaved(null); create.reset();
      }}>new instruction</button>}
    </div>
    <p class="settings-intro">Your standing instructions, in Markdown. Agents inherit their owner’s instructions alongside their own. Changes take effect when an agent next refreshes its standing context.</p>
    {!canRead && <p class="settings-muted">Your account cannot read instruction files.</p>}
    {canRead && !canWrite && <p class="settings-muted">You can read your instructions but cannot save changes.</p>}
    <SettingsError error={files.error} />
    {files.isPending && connected && canRead && <LoadingState variant="panel">Loading instructions…</LoadingState>}
    {deleted && <p role="status">Deleted {deleted}.</p>}
    {!newDraft && files.data?.length === 0 && <p>No instruction files yet.</p>}
    {!newDraft && files.data && files.data.length > 0 && <>
      <label>Instruction file<select value={name ?? ""} disabled={pending} onChange={(event) => { setSelected(event.currentTarget.value); setConfirmDelete(false); setDeleted(null); setSaved(null); remove.reset(); }}>
        {files.data.map((entry) => <option key={entry} value={entry}>{entry}{drafts[entry] && drafts[entry].content !== drafts[entry].original ? " · unsaved" : ""}</option>)}
      </select></label>
      <SettingsError error={file.error ?? currentError ?? remove.error} />
      {file.isPending && connected && <LoadingState>Reading instructions…</LoadingState>}
    </>}
    {newDraft && <div class="settings-instruction-heading">
      <h2>New instruction</h2>
      <button class="settings-text-action" type="button" disabled={pending} onClick={() => {
        if (!newDirty || window.confirm("Discard this new instruction?")) { setNewDraft(null); create.reset(); }
      }}>cancel</button>
    </div>}
    {(newDraft || name) && <form aria-label={newDraft ? "New instruction" : "Edit instruction"} onSubmit={(event) => {
      event.preventDefault();
      if (newDraft) { if (canCreate && newName) create.mutate({ name: newName, content: newDraft.content }); }
      else if (editable && name && content !== undefined) save.mutate({ name, content });
    }}>
      {newDraft && <>
        <label>File name <small>.md is added automatically.</small><input name="instruction-name" autoFocus autoComplete="off" value={newDraft.name} readOnly={!editable} placeholder="e.g. writing-style" aria-invalid={!!nameError} aria-describedby={nameError ? "instruction-name-error" : undefined} onInput={(event) => { setNewDraft({ ...newDraft, name: event.currentTarget.value }); create.reset(); }} /></label>
        {nameError && <p class="settings-error" id="instruction-name-error" role="alert">{nameError}</p>}
        <SettingsError error={create.error} />
      </>}
      {content !== undefined && <>
        <label>{newDraft ? "Instructions" : name}<textarea class="settings-instruction-editor" aria-label="Instruction content" spellcheck={false} value={content} readOnly={!editable} onInput={(event) => {
          const value = event.currentTarget.value;
          if (newDraft) { setNewDraft({ ...newDraft, content: value }); create.reset(); }
          else if (name) { setDrafts({ ...drafts, [name]: { original: draft?.original ?? file.data!, content: value } }); save.reset(); }
          setSaved(null);
        }} /></label>
        <div class="settings-actions">
          {newDraft ? <button class="ibtn" type="submit" disabled={!canCreate}>{create.isPending ? <LoadingState>creating…</LoadingState> : "create instruction"}</button>
            : <button class="ibtn" type="submit" disabled={!editable || !draft || draft.content === draft.original}>{save.isPending ? <LoadingState>saving…</LoadingState> : "save instructions"}</button>}
          {!newDraft && name && draft && draft.content !== draft.original && <button class="ibtn" type="button" disabled={pending} onClick={() => { forgetDraft(name); save.reset(); }}>discard changes</button>}
          {!newDraft && saved === name && <span role="status">saved</span>}
        </div>
      </>}
    </form>}
    {!newDraft && name && files.data?.includes(name) && canRead && canDelete && <div class="settings-instruction-removal">
      {confirmDelete ? <div role="group" aria-label={`Delete ${name}`}>
        <p>Delete {name}?{draft && draft.content !== draft.original ? " Your unsaved changes to this file will also be discarded." : ""}</p>
        <div class="settings-actions">
          <button class="settings-text-action settings-danger" type="button" disabled={!connected || pending || files.isError} onClick={() => remove.mutate(name)}>{remove.isPending ? <LoadingState>deleting…</LoadingState> : "delete instruction"}</button>
          <button class="settings-text-action" type="button" disabled={pending} onClick={() => { setConfirmDelete(false); remove.reset(); }}>cancel</button>
        </div>
      </div> : <button class="settings-text-action settings-danger" type="button" disabled={!connected || pending || files.isError} onClick={() => { setConfirmDelete(true); remove.reset(); }}>delete</button>}
    </div>}
  </section>;
}
