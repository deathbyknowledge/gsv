import { resolveLocale, useT } from "../../../i18n/locale";

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
  { value: "pt-BR", label: "Português" },
];

export function Language({ value, editable, onChange }: { value: string; editable: boolean; onChange: (value: string) => void }) {
  const t = useT();
  const locale = resolveLocale(value || undefined, globalThis.navigator?.languages ?? []).tag;
  const selected = LANGUAGES.some((language) => language.value === locale) ? locale : "en";
  return <div class="settings-form">
    <label>{t("settings.language.label")}<select value={selected} disabled={!editable} onChange={(event) => onChange(event.currentTarget.value)}>
      {LANGUAGES.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}
    </select></label>
    <p class="settings-muted">{t("settings.language.hint")}</p>
  </div>;
}
