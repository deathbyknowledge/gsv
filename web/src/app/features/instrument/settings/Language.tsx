import { useState } from "preact/hooks";
import { useT } from "../../../i18n/locale";

const LANGUAGES = ["ar", "de", "en", "es", "fr", "hi", "id", "it", "ja", "ko", "nl", "pt-BR", "pt", "ru", "tr", "uk", "zh"];

export function Language({ value, editable, onChange }: { value: string; editable: boolean; onChange: (value: string) => void }) {
  const t = useT();
  const [custom, setCustom] = useState(false);
  return <div class="settings-form">
    <label>{t("settings.language.label")}<select value={custom ? "custom" : value} disabled={!editable} onChange={(event) => {
      const selected = event.currentTarget.value;
      setCustom(selected === "custom");
      if (selected !== "custom") onChange(selected);
    }}>
      <option value="">{t("settings.language.placeholder")}</option>
      {value && !LANGUAGES.includes(value) && <option value={value}>{value}</option>}
      {LANGUAGES.map((language) => <option key={language} value={language}>{new Intl.DisplayNames([language], { type: "language" }).of(language)}</option>)}
      <option value="custom">{t("settings.language.custom")}</option>
    </select></label>
    {custom && <label>{t("settings.language.code")}<input value={value} placeholder="es-MX" disabled={!editable} onInput={(event) => { onChange(event.currentTarget.value); }} /></label>}
    <p class="settings-muted">{t("settings.language.hint")}</p>
    <button type="button" class="settings-text-action" disabled={!editable} onClick={() => { onChange(navigator.languages?.[0] || navigator.language || ""); setCustom(false); }}>{t("settings.language.useDevice")}</button>
  </div>;
}
