import { createContext, type ComponentChildren } from "preact";
import { useContext } from "preact/hooks";

const Footer = createContext<ComponentChildren>(null);

export function SetupFooterProvider({ footer, children }: { footer: ComponentChildren; children: ComponentChildren }) {
  return <Footer.Provider value={footer}>{children}</Footer.Provider>;
}

/** The host can add a note under the first-boot setup form. Desktop leaves this slot empty. */
export function SetupFooter() {
  return <>{useContext(Footer)}</>;
}
