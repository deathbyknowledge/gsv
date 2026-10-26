import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { saveConsoleConfig } from "../../../services/system/consoleService";
import { TextInput } from "../../../components/ui/TextInput";
import { SETTINGS_CONFIG_KEY } from "./settingsModel";
import { SettingsError, useSettingsDirty } from "./settingsShared";
import { useT } from "../../../i18n/locale";

export function Language({ uid, original, editable, onDirty }: { uid: number; original: string; editable: boolean; onDirty: (dirty: boolean) => void }) {
  const t = useT();
  const { client } = useGateway();
  const cache = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? original;
  const save = useMutation({
    mutationFn: () => saveConsoleConfig(client, { key: `users/${uid}/locale/language`, value: value.trim() }),
    onSuccess: async () => { await cache.invalidateQueries({ queryKey: SETTINGS_CONFIG_KEY }); setDraft(null); },
  });
  useSettingsDirty(value !== original || save.isPending, onDirty);
  return <form class="settings-form" aria-label={t("settings.language.label")} onSubmit={(event) => { event.preventDefault(); if (editable && !save.isPending) save.mutate(); }}>
    <TextInput label={t("settings.language.label")} placeholder={t("settings.language.placeholder")} value={value} disabled={!editable || save.isPending} inputProps={{ list: "response-languages" }} onChange={(next) => { setDraft(next); save.reset(); }} />
    <datalist id="response-languages">{["ar", "de", "en", "es", "fr", "hi", "it", "ja", "ko", "nl", "pt", "ru", "tr", "uk", "zh"].map((language) => <option key={language} value={language}>{new Intl.DisplayNames([language], { type: "language" }).of(language)}</option>)}</datalist>
    <p class="settings-muted">{t("settings.language.hint")}</p>
    <div class="settings-actions"><button class="ibtn" type="submit" disabled={!editable || save.isPending || value === original}>{t(save.isPending ? "common.saving" : "settings.language.save")}</button><button type="button" class="settings-text-action" disabled={!editable || save.isPending} onClick={() => { setDraft(navigator.languages?.[0] || navigator.language || ""); save.reset(); }}>{t("settings.language.useDevice")}</button>{save.isSuccess && <span role="status">{t("common.saved")}</span>}</div>
    <SettingsError error={save.error} />
  </form>;
}
