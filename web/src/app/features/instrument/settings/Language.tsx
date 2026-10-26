import { useT } from "../../../i18n/locale";

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
  { value: "pt-BR", label: "Português" },
];

export function Language({ value, editable, onChange }: { value: string; editable: boolean; onChange: (value: string) => void }) {
  const t = useT();
  const baseLanguage = value.toLowerCase().split("-")[0];
  const selected = LANGUAGES.find((language) => language.value.toLowerCase().split("-")[0] === baseLanguage)?.value ?? value;
  return <div class="settings-form">
    <label>{t("settings.language.label")}<select value={selected} disabled={!editable} onChange={(event) => onChange(event.currentTarget.value)}>
      {!LANGUAGES.some((language) => language.value === selected) && <option value={value}>{value || t("settings.language.placeholder")}</option>}
      {LANGUAGES.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}
    </select></label>
    <p class="settings-muted">{t("settings.language.hint")}</p>
  </div>;
}
