import { createContext, type ComponentChildren } from "preact";
import { useContext } from "preact/hooks";

const Identity = createContext<ComponentChildren>(null);

export function PlatformIdentityProvider({ identity, children }: { identity: ComponentChildren; children: ComponentChildren }) {
  return <Identity.Provider value={identity}>{children}</Identity.Provider>;
}

/** The host can supply a space control in the shared header. Browsers leave this slot empty. */
export function PlatformIdentity() {
  return <>{useContext(Identity)}</>;
}
