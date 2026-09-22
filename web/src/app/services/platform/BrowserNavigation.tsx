import { createContext, type ComponentChildren } from "preact";
import { useContext } from "preact/hooks";

type BrowserNavigation = (url: string) => Promise<void>;

const Navigation = createContext<BrowserNavigation>(async (url) => { window.location.assign(url); });

/** The host opens browser flows externally; the web UI navigates in its current tab. */
export function BrowserNavigationProvider({ navigate, children }: { navigate: BrowserNavigation; children: ComponentChildren }) {
  return <Navigation.Provider value={navigate}>{children}</Navigation.Provider>;
}

export const useBrowserNavigation = () => useContext(Navigation);
