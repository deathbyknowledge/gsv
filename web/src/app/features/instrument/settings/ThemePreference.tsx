import { useColorTheme, type ColorThemePreference } from "../../../components/ui/useColorTheme";
import { useStarsPreference } from "../shared/useStarsPreference";
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
  const { showStars, setStars } = useStarsPreference();
  return <div class="settings-form">
    <h2>{t("settings.appearance.title")}</h2>
    <label>{t("settings.appearance.theme")}<select value={preference ?? ""} onChange={(event) => {
      const option = THEME_OPTIONS.find((candidate) => candidate.value === event.currentTarget.value);
      if (option) setPreference(option.value);
    }}>
      {preference === null && <option value="" disabled>{t("settings.appearance.default")}</option>}
      {THEME_OPTIONS.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
    </select></label>
    <label class="settings-check"><input type="checkbox" checked={showStars} onChange={(event) => setStars(event.currentTarget.checked)} />{t("settings.appearance.showStars")}</label>
    <p class="settings-muted">{t("settings.appearance.hint")}</p>
  </div>;
}
