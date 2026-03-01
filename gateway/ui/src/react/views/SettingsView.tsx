import { useState } from "react";
import { SHELL_STYLE_OPTIONS, WALLPAPER_OPTIONS } from "../../ui/storage";
import { useReactUiStore } from "../state/store";
import { PairingView } from "./PairingView";
import { ConfigView } from "./ConfigView";
import { DebugView } from "./DebugView";

type SettingsTab = "display" | "gateway" | "pairing" | "debug";

const SETTINGS_TABS: { id: SettingsTab; label: string; hint: string }[] = [
  { id: "display", label: "Display", hint: "Theme and wallpaper" },
  { id: "gateway", label: "Gateway", hint: "Model, providers, policies" },
  { id: "pairing", label: "Pairing", hint: "Sender approvals" },
  { id: "debug", label: "Debug", hint: "Protocol diagnostics" },
];

function DisplaySettings() {
  const settings = useReactUiStore((s) => s.settings);
  const updateSettings = useReactUiStore((s) => s.updateSettings);
  const currentWallpaper = settings.wallpaper ?? "mesh";

  return (
    <div className="app-list" style={{ gap: "var(--space-4)" }}>
      <section className="app-panel">
        <header className="app-panel-head">
          <h3 className="app-panel-title">Wallpaper</h3>
          <span className="app-panel-meta">desktop backdrop</span>
        </header>
        <div className="app-panel-body">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: "var(--space-3)",
            }}
          >
            {WALLPAPER_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className="app-list-item"
                onClick={() => updateSettings({ wallpaper: opt.id })}
                style={{
                  textAlign: "left",
                  cursor: "pointer",
                  borderColor:
                    opt.id === currentWallpaper
                      ? "var(--glass-border-active)"
                      : undefined,
                }}
              >
                <div
                  className={`settings-wallpaper-swatch os-wp-${opt.id}`}
                  style={{
                    height: 84,
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--glass-border)",
                    marginBottom: "var(--space-3)",
                    overflow: "hidden",
                  }}
                />
                <div className="app-list-title">{opt.label}</div>
                <div className="app-list-subtitle">{opt.description}</div>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="app-panel">
        <header className="app-panel-head">
          <h3 className="app-panel-title">Theme</h3>
          <span className="app-panel-meta">UI mode</span>
        </header>
        <div className="app-panel-body">
          <div className="app-actions">
            {(["dark", "light", "system"] as const).map((theme) => (
              <button
                key={theme}
                type="button"
                className={`app-tab ${settings.theme === theme ? "active" : ""}`}
                onClick={() => updateSettings({ theme })}
              >
                {theme.charAt(0).toUpperCase() + theme.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="app-panel">
        <header className="app-panel-head">
          <h3 className="app-panel-title">Shell Style</h3>
          <span className="app-panel-meta">window chrome + taskbar</span>
        </header>
        <div className="app-panel-body">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: "var(--space-3)",
            }}
          >
            {SHELL_STYLE_OPTIONS.map((styleOption) => (
              <button
                key={styleOption.id}
                type="button"
                className="app-list-item"
                onClick={() => updateSettings({ shellStyle: styleOption.id })}
                style={{
                  textAlign: "left",
                  cursor: "pointer",
                  borderColor:
                    settings.shellStyle === styleOption.id
                      ? "color-mix(in srgb, var(--text-primary) 42%, var(--glass-border))"
                      : undefined,
                }}
              >
                <div className="app-list-title">{styleOption.label}</div>
                <div className="app-list-subtitle">{styleOption.description}</div>
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

export function SettingsView() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("display");
  const activeTabMeta = SETTINGS_TABS.find((tab) => tab.id === activeTab);

  return (
    <div className="view-container">
      <div className="app-shell" data-app="settings">
        <section className="app-hero">
          <div className="app-hero-content">
            <div>
              <h2 className="app-hero-title">Settings Center</h2>
              <p className="app-hero-subtitle">
                Configuration grouped by resource with dedicated tabs for display,
                gateway runtime, pairing controls, and debug tools.
              </p>
              <div className="app-hero-meta">
                <span className="app-badge-dot" />
                <span>{activeTabMeta?.hint}</span>
              </div>
            </div>
          </div>
        </section>

        <div className="app-tabs" role="tablist" aria-label="Settings sections">
          {SETTINGS_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`app-tab ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "display" ? <DisplaySettings /> : null}
        {activeTab === "gateway" ? <ConfigView embedded /> : null}
        {activeTab === "pairing" ? <PairingView embedded /> : null}
        {activeTab === "debug" ? <DebugView embedded /> : null}
      </div>
    </div>
  );
}
