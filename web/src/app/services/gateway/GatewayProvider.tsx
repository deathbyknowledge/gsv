import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import { GSVClient, type GsvClientStatus } from "@humansandmachines/gsv/client";

type GatewayContextValue = {
  client: GSVClient;
  status: GsvClientStatus;
  connected: boolean;
};

const GatewayContext = createContext<GatewayContextValue | null>(null);

type GatewayProviderProps = {
  children: ComponentChildren;
};

function createWebGsvClient(): GSVClient {
  return new GSVClient({
    client: {
      id: "gsv-ui",
      version: "0.2.9",
      platform: "browser",
      role: "user",
    },
  });
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
