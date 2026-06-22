import { Icon } from "../../../components/ui/Icon";
import type { ShellPageTab } from "../domain/shellModel";

type DesktopTabsDockProps = {
  activeTabKey: string | null;
  openTabs: readonly ShellPageTab[];
  onActivateTab: (key: string) => void;
  onCloseTab: (key: string) => void;
};

export function DesktopTabsDock({
  activeTabKey,
  openTabs,
  onActivateTab,
  onCloseTab,
}: DesktopTabsDockProps) {
  if (openTabs.length === 0) {
    return null;
  }

  return (
    <aside class="gsv-desktop-tabs" aria-label="Open tabs">
      <header>
        <span>TABS</span>
        <small>{openTabs.length}</small>
      </header>
      <div>
        {openTabs.map((tab) => (
          <div
            class={`gsv-desktop-tab-row${tab.key === activeTabKey ? " is-active" : ""}`}
            key={tab.key}
          >
            <button type="button" onClick={() => onActivateTab(tab.key)}>
              <Icon name={tab.icon} size={17} />
              <span>{tab.title}</span>
            </button>
            <button type="button" aria-label={`Close ${tab.title}`} onClick={() => onCloseTab(tab.key)}>
              <Icon name="doticons/x" size={12} />
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
