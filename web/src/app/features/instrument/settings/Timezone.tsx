import { useT } from "../../../i18n/locale";

export function Timezone({ value, fallback, editable, onChange }: { value: string; fallback: string; editable: boolean; onChange: (value: string) => void }) {
  const t = useT();
  return <div class="settings-form">
    <label>{t("settings.timezone.label")}<input value={value} placeholder={fallback} disabled={!editable} onInput={(event) => onChange(event.currentTarget.value)} /></label>
    <p class="settings-muted">{t("settings.timezone.hint")}</p>
    <button type="button" class="settings-text-action" disabled={!editable} onClick={() => onChange(Intl.DateTimeFormat().resolvedOptions().timeZone)}>{t("settings.timezone.useDevice")}</button>
  </div>;
}
