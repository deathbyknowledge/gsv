import { Icon } from "../../../components/ui/Icon";
import { StatusDot } from "../../../components/ui/StatusDot";
import type { ShellPageTab } from "../domain/shellModel";

type DesktopTabStackProps = {
  activeTabKey: string | null;
  tabs: readonly ShellPageTab[];
  onCloseTab: (key: string) => void;
  onOpenTab: (key: string) => void;
};

function tabStatus(active: boolean) {
  return active ? "live" : "online";
}

export function DesktopTabStack({
  activeTabKey,
  tabs,
  onCloseTab,
  onOpenTab,
}: DesktopTabStackProps) {
  if (tabs.length === 0) {
    return null;
  }

  return (
    <nav class="gsv-desktop-tab-stack" aria-label="Open pages">
      <header>
        <span>TABS</span>
        <small>{tabs.length}</small>
      </header>
      <div class="gsv-desktop-tab-list">
        {tabs.map((tab) => {
          const active = tab.key === activeTabKey;
          return (
            <div class={`gsv-desktop-tab-row${active ? " is-active" : ""}`} key={tab.key}>
              <button type="button" onClick={() => onOpenTab(tab.key)}>
                <span class="gsv-desktop-tab-icon">
                  <Icon name={tab.icon} size={18} color="var(--accent-bright)" />
                </span>
                <span class="gsv-desktop-tab-copy">
                  <span>{tab.title}</span>
                  <small>
                    <StatusDot tone={tabStatus(active)} size={6} />
                    {tab.type}
                  </small>
                </span>
              </button>
              <button
                type="button"
                class="gsv-desktop-tab-close"
                title={`Close ${tab.title}`}
                aria-label={`Close ${tab.title}`}
                onClick={() => onCloseTab(tab.key)}
              >
                x
              </button>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
