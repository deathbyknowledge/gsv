import { Select } from "../../../components/ui/Select";
import { useColorTheme, type ColorThemePreference } from "../../../components/ui/useColorTheme";
import { useT, type TextKey } from "../../../i18n/locale";

const THEME_OPTIONS: ReadonlyArray<{ value: ColorThemePreference; label: TextKey }> = [
  { value: "system", label: "settings.appearance.system" },
  { value: "light", label: "settings.appearance.light" },
  { value: "dark", label: "settings.appearance.dark" },
];

/** A per-device choice kept in browser storage; it never goes through server settings. */
export function ThemePreference() {
  const t = useT();
  const { preference, setPreference } = useColorTheme("light");
  return <div class="settings-form">
    <h2>{t("settings.appearance.title")}</h2>
    <Select
      block
      label={t("settings.appearance.theme")}
      placeholder={t("settings.appearance.default")}
      selected={preference ?? ""}
      options={THEME_OPTIONS.map((option) => ({ label: t(option.label), value: option.value }))}
      onSelect={(value) => {
        const option = THEME_OPTIONS.find((candidate) => candidate.value === value);
        if (option) setPreference(option.value);
      }}
    />
    <p class="settings-muted">{t("settings.appearance.hint")}</p>
  </div>;
}
