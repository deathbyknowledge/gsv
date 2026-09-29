import { createContext, type ComponentChildren } from "preact";
import { useContext, useEffect, useLayoutEffect, useState } from "preact/hooks";
import { useGateway } from "../gateway/GatewayProvider";
import { useSession } from "../session/SessionProvider";
import { DevicePairingSession, type DevicePairingState } from "./devicePairing";

const Context = createContext<{ pairing: DevicePairingSession; state: DevicePairingState } | null>(null);

export function DevicePairingProvider({ children }: { children: ComponentChildren }) {
  const { client } = useGateway();
  const { snapshot } = useSession();
  const [pairing] = useState(() => {
    const key = `gsv.pairing.v1:${JSON.stringify([snapshot.url, snapshot.username])}`;
    return new DevicePairingSession(client.sys.pair, {
      read: () => window.sessionStorage.getItem(key),
      write: (value) => window.sessionStorage.setItem(key, value),
    });
  });
  const [state, setState] = useState(pairing.snapshot);
  useLayoutEffect(() => pairing.subscribe(() => setState(pairing.snapshot())), [pairing]);
  useEffect(() => () => pairing.dispose(), [pairing]);
  return <Context.Provider value={{ pairing, state }}>{children}</Context.Provider>;
}

export function useDevicePairing() {
  const context = useContext(Context);
  if (!context) throw new Error("Device pairing requires its signed-in owner");
  return context;
}
