import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import { createSessionService, type SessionService, type SessionSnapshot } from "./sessionService";
import { useGateway } from "../gateway/GatewayProvider";

type SessionContextValue = {
  service: SessionService;
  snapshot: SessionSnapshot;
};

const SessionContext = createContext<SessionContextValue | null>(null);

type SessionProviderProps = {
  children: ComponentChildren;
};

export function SessionProvider({ children }: SessionProviderProps) {
  const { client } = useGateway();
  const [service] = useState(() => createSessionService(client));
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(() => service.snapshot());

  useEffect(() => {
    return service.subscribe(setSnapshot);
  }, [service]);

  return (
    <SessionContext.Provider value={{ service, snapshot }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error("useSession must be used within SessionProvider");
  }
  return value;
}
