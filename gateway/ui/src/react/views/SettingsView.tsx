import { useState } from "react";
import { WALLPAPER_OPTIONS, type Wallpaper } from "../../ui/storage";
import { useReactUiStore } from "../state/store";
import { PairingView } from "./PairingView";
import { ConfigView } from "./ConfigView";
import { DebugView } from "./DebugView";

type SettingsTab = "display" | "pairing" | "config" | "debug";

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "display", label: "Display" },
  { id: "pairing", label: "Pairing" },
  { id: "config", label: "Config" },
  { id: "debug", label: "Debug" },
];

function DisplaySettings() {
  const settings = useReactUiStore((s) => s.settings);
  const updateSettings = useReactUiStore((s) => s.updateSettings);
  const currentWallpaper = settings.wallpaper ?? "mesh";

  return (
    <div className="settings-display">
      <h3 className="settings-section-title">Wallpaper</h3>
      <p className="settings-section-desc">
        Choose a desktop background. You can also right-click the desktop to change wallpaper.
      </p>
      <div className="settings-wallpaper-grid">
        {WALLPAPER_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className={`settings-wallpaper-card ${opt.id === currentWallpaper ? "active" : ""}`}
            onClick={() => updateSettings({ wallpaper: opt.id })}
          >
            <div className={`settings-wallpaper-preview os-wp-${opt.id}`} />
            <div className="settings-wallpaper-info">
              <span className="settings-wallpaper-name">{opt.label}</span>
              <span className="settings-wallpaper-desc">{opt.description}</span>
            </div>
          </button>
        ))}
      </div>

      <h3 className="settings-section-title" style={{ marginTop: "1.5rem" }}>Theme</h3>
      <div className="settings-theme-row">
        {(["dark", "light", "system"] as const).map((theme) => (
          <button
            key={theme}
            type="button"
            className={`settings-theme-btn ${settings.theme === theme ? "active" : ""}`}
            onClick={() => updateSettings({ theme })}
          >
            {theme.charAt(0).toUpperCase() + theme.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SettingsView() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("display");

  return (
    <div className="view-container">
      <div className="tabs">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`tab ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {activeTab === "display" && <DisplaySettings />}
      {activeTab === "pairing" && <PairingView />}
      {activeTab === "config" && <ConfigView />}
      {activeTab === "debug" && <DebugView />}
    </div>
  );
}
