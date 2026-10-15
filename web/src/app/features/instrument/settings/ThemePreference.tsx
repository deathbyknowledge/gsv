import { useColorTheme, type ColorThemePreference } from "../../../components/ui/useColorTheme";

const THEME_OPTIONS: ReadonlyArray<{ value: ColorThemePreference; label: string }> = [
  { value: "system", label: "Match system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** A per-device choice kept in browser storage; it never goes through server settings. */
export function ThemePreference() {
  const { preference, setPreference } = useColorTheme();
  return <div class="settings-form">
    <h2>Appearance</h2>
    <label>Theme<select value={preference} onChange={(event) => {
      const option = THEME_OPTIONS.find((candidate) => candidate.value === event.currentTarget.value);
      if (option) setPreference(option.value);
    }}>
      {THEME_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select></label>
    <p class="settings-muted">Saved on this device only, not to your account. Press l outside a text field to switch between light and dark.</p>
  </div>;
}
