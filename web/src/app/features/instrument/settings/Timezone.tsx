import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { saveConsoleConfig } from "../../../services/system/consoleService";
import { SETTINGS_CONFIG_KEY } from "./settingsModel";
import { SettingsError, useSettingsDirty } from "./settingsShared";

export function Timezone({ uid, original, fallback, editable, onDirty }: { uid: number; original: string; fallback: string; editable: boolean; onDirty: (dirty: boolean) => void }) {
  const { client } = useGateway();
  const cache = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? original;
  const save = useMutation({
    mutationFn: async () => {
      const timezone = value.trim();
      if (timezone) {
        try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); }
        catch { throw new Error("Choose a valid timezone, such as Europe/Amsterdam."); }
      }
      await saveConsoleConfig(client, { key: `users/${uid}/locale/timezone`, value: timezone });
    },
    onSuccess: async () => { await cache.invalidateQueries({ queryKey: SETTINGS_CONFIG_KEY }); setDraft(null); },
  });
  useSettingsDirty(value !== original || save.isPending, onDirty);
  return <form class="settings-form" aria-label="Timezone" onSubmit={(event) => { event.preventDefault(); if (editable && !save.isPending) save.mutate(); }}>
    <label>Timezone<input value={value} placeholder={fallback} disabled={!editable || save.isPending} onInput={(event) => { setDraft(event.currentTarget.value); save.reset(); }} /></label>
    <p class="settings-muted">Your local time for Ship and new routines. Existing routines keep their own timezone.</p>
    <div class="settings-actions"><button class="ibtn" type="submit" disabled={!editable || save.isPending || value === original}>{save.isPending ? "saving…" : "save timezone"}</button><button type="button" class="settings-text-action" disabled={!editable || save.isPending} onClick={() => { setDraft(Intl.DateTimeFormat().resolvedOptions().timeZone); save.reset(); }}>use this device’s timezone</button>{save.isSuccess && <span role="status">saved</span>}</div>
    <SettingsError error={save.error} />
  </form>;
}
