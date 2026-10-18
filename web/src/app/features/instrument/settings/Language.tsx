import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { saveConsoleConfig } from "../../../services/system/consoleService";
import { SETTINGS_CONFIG_KEY } from "./settingsModel";
import { SettingsError, useSettingsDirty } from "./settingsShared";

export function Language({ uid, original, editable, onDirty }: { uid: number; original: string; editable: boolean; onDirty: (dirty: boolean) => void }) {
  const { client } = useGateway();
  const cache = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? original;
  const save = useMutation({
    mutationFn: () => saveConsoleConfig(client, { key: `users/${uid}/locale/language`, value: value.trim() }),
    onSuccess: async () => { await cache.invalidateQueries({ queryKey: SETTINGS_CONFIG_KEY }); setDraft(null); },
  });
  useSettingsDirty(value !== original || save.isPending, onDirty);
  return <form class="settings-form" aria-label="Response language" onSubmit={(event) => { event.preventDefault(); if (editable && !save.isPending) save.mutate(); }}>
    <label>Response language<input value={value} list="response-languages" placeholder="Follow the conversation" disabled={!editable || save.isPending} onInput={(event) => { setDraft(event.currentTarget.value); save.reset(); }} /></label>
    <datalist id="response-languages">{["ar", "de", "en", "es", "fr", "hi", "it", "ja", "ko", "nl", "pt", "ru", "tr", "uk", "zh"].map((language) => <option key={language} value={language}>{new Intl.DisplayNames([language], { type: "language" }).of(language)}</option>)}</datalist>
    <p class="settings-muted">A starting language for Ship. Choose a suggestion or enter a language code, such as es-MX. You can ask Ship to switch at any time.</p>
    <div class="settings-actions"><button class="ibtn" type="submit" disabled={!editable || save.isPending || value === original}>{save.isPending ? "saving…" : "save language"}</button><button type="button" class="settings-text-action" disabled={!editable || save.isPending} onClick={() => { setDraft(navigator.languages?.[0] || navigator.language || ""); save.reset(); }}>use this device’s language</button>{save.isSuccess && <span role="status">saved</span>}</div>
    <SettingsError error={save.error} />
  </form>;
}
