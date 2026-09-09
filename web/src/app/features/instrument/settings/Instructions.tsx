import { LoadingState } from "../../../components/ui/Spinner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { canConfigure, SETTINGS_INSTRUCTIONS_KEY } from "./settingsModel";
import { listInstructions, readInstruction, saveInstruction } from "./settingsService";
import { SettingsError, useSettingsDirty, type SettingsSectionProps } from "./settingsShared";

type InstructionDraft = { original: string; content: string };

export function Instructions({ account, active, onDirty }: SettingsSectionProps) {
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, InstructionDraft>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const key = [...SETTINGS_INSTRUCTIONS_KEY, account.uid];
  const canRead = canConfigure(account, "fs.read");
  const canWrite = canConfigure(account, "fs.write");
  const files = useQuery({ queryKey: [...key, "list"], queryFn: () => listInstructions(client), enabled: connected && active && canRead });
  const name = selected ?? files.data?.[0] ?? null;
  const file = useQuery({ queryKey: [...key, "file", name], queryFn: () => readInstruction(client, name!), enabled: connected && active && canRead && name !== null });
  const draft = name ? drafts[name] : undefined;
  const content = draft?.content ?? file.data;
  const dirty = Object.values(drafts).some((entry) => entry.content !== entry.original);
  useSettingsDirty(dirty, onDirty);
  const save = useMutation({
    mutationFn: (input: { name: string; content: string }) => saveInstruction(client, input.name, input.content),
    onSuccess: (_, input) => {
      cache.setQueryData([...key, "file", input.name], input.content);
      setDrafts((current) => {
        const next = { ...current };
        delete next[input.name];
        return next;
      });
      setSaved(input.name);
    },
  });
  const editable = connected && canWrite && content !== undefined && !file.isError && !files.isError && !save.isPending;
  const currentError = save.variables?.name === name ? save.error : null;
  return <section aria-labelledby="settings-instructions-title">
    <h1 id="settings-instructions-title">Instructions</h1>
    <p class="settings-intro">Your standing instructions, in Markdown. Agents inherit their owner’s instructions alongside their own. Changes take effect when an agent next refreshes its standing context.</p>
    {!canRead && <p class="settings-muted">Your account cannot read instruction files.</p>}
    {canRead && !canWrite && <p class="settings-muted">You can read your instructions but cannot edit them.</p>}
    <SettingsError error={files.error} />
    {files.isPending && connected && canRead && <LoadingState variant="panel">Loading instructions…</LoadingState>}
    {files.data?.length === 0 && <p>No Markdown instruction files exist yet.</p>}
    {files.data && files.data.length > 0 && <>
      <label>Instruction file<select value={name ?? ""} onChange={(event) => setSelected(event.currentTarget.value)}>
        {files.data.map((entry) => <option key={entry} value={entry}>{entry}{drafts[entry] && drafts[entry].content !== drafts[entry].original ? " · unsaved" : ""}</option>)}
      </select></label>
      <SettingsError error={file.error ?? currentError} />
      {file.isPending && connected && <LoadingState>Reading instructions…</LoadingState>}
      {content !== undefined && name && <form onSubmit={(event) => { event.preventDefault(); if (editable) save.mutate({ name, content }); }}>
        <label>{name}<textarea class="settings-instruction-editor" aria-label="Instruction content" spellcheck={false} value={content} readOnly={!editable} onInput={(event) => {
          const value = event.currentTarget.value;
          setDrafts({ ...drafts, [name]: { original: draft?.original ?? file.data!, content: value } });
          setSaved(null);
        }} /></label>
        <div class="settings-actions">
          <button class="ibtn" type="submit" disabled={!editable || !draft || draft.content === draft.original}>{save.isPending ? <LoadingState>saving…</LoadingState> : "save instructions"}</button>
          {draft && draft.content !== draft.original && <button class="ibtn" type="button" disabled={save.isPending} onClick={() => setDrafts((current) => { const next = { ...current }; delete next[name]; return next; })}>discard changes</button>}
          {saved === name && <span role="status">saved</span>}
        </div>
      </form>}
    </>}
  </section>;
}
