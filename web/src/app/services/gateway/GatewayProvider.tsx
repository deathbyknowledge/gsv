import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import { GSVClient, type GsvClientStatus, type GsvPeerInfo } from "@humansandmachines/gsv/client";
import { createMockGatewayClient, mockGatewayRequested } from "./mockGateway";

type GatewayContextValue = {
  client: GSVClient;
  status: GsvClientStatus;
  connected: boolean;
};

const GatewayContext = createContext<GatewayContextValue | null>(null);

type GatewayProviderProps = {
  children: ComponentChildren;
};

const WEB_PEER: GsvPeerInfo = {
  id: "gsv-ui",
  version: "0.6.1",
  platform: "browser",
};

function createWebGsvClient(): GSVClient {
  // Dev only: `?mock=1` swaps in the in-memory gateway; the DEV check keeps it out of production bundles.
  // The dev server with ?mock=1 gets the in-memory gateway; DEV is a build-time constant, so production bundles drop it.
  if (import.meta.env.DEV && mockGatewayRequested()) return createMockGatewayClient(WEB_PEER);
  return new GSVClient({ peer: WEB_PEER });
}

export function GatewayProvider({ children }: GatewayProviderProps) {
  const [client] = useState(createWebGsvClient);
  const [status, setStatus] = useState<GsvClientStatus>(() => client.getStatus());

  useEffect(() => {
    return client.onStatus(setStatus);
  }, [client]);

  return (
    <GatewayContext.Provider
      value={{
        client,
        status,
        connected: status.state === "connected",
      }}
    >
      {children}
    </GatewayContext.Provider>
  );
}

export function useGateway(): GatewayContextValue {
  const value = useContext(GatewayContext);
  if (!value) {
    throw new Error("useGateway must be used within GatewayProvider");
  }
  return value;
}
