import { Select } from "../../../components/ui/Select";
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
    <Select block label={t("settings.language.label")} selected={selected} disabled={!editable} onSelect={onChange}
      options={[
        ...(LANGUAGES.some((language) => language.value === selected) ? [] : [{ label: value || t("settings.language.placeholder"), value }]),
        ...LANGUAGES,
      ]} />
    <p class="settings-muted">{t("settings.language.hint")}</p>
  </div>;
}
