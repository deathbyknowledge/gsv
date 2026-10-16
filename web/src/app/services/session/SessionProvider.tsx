import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import { createSessionService, type SessionService, type SessionSnapshot } from "./sessionService";
import { useGateway } from "../gateway/GatewayProvider";
import { bindSessionPresentation } from "../deployment";

type SessionContextValue = {
  service: SessionService;
  snapshot: SessionSnapshot;
};

const SessionContext = createContext<SessionContextValue | null>(null);

type SessionProviderProps = {
  children: ComponentChildren;
  createService?: typeof createSessionService;
};

export function SessionProvider({
  children,
  createService = createSessionService,
}: SessionProviderProps) {
  const { client } = useGateway();
  const [service] = useState(() => createService(client));
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(() => service.snapshot());

  useEffect(() => {
    const clearPresentation = bindSessionPresentation(() => service.snapshot().server?.deployment);
    const unsubscribe = service.subscribe(setSnapshot);
    void service.start();
    return () => { clearPresentation(); unsubscribe(); service.dispose?.(); };
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
