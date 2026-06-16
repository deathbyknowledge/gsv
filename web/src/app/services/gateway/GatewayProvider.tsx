import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import {
  createGatewayClient,
  type GatewayClient,
  type GatewayClientStatus,
} from "../../../gateway-client";

type GatewayContextValue = {
  client: GatewayClient;
  status: GatewayClientStatus;
  connected: boolean;
};

const GatewayContext = createContext<GatewayContextValue | null>(null);

type GatewayProviderProps = {
  children: ComponentChildren;
};

export function GatewayProvider({ children }: GatewayProviderProps) {
  const [client] = useState(createGatewayClient);
  const [status, setStatus] = useState<GatewayClientStatus>(() => client.getStatus());

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
