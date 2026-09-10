import { createContext, type ComponentChildren } from "preact";
import { useContext, useEffect, useLayoutEffect, useState } from "preact/hooks";
import { useGateway } from "../gateway/GatewayProvider";
import { useSession } from "../session/SessionProvider";
import { cancelTerminalCommand, executeTerminalCommand } from "./backend/terminalService";
import { TerminalSessions, type TerminalSession } from "./terminalSessions";

type TerminalContextValue = { sessions: TerminalSessions; rows: readonly TerminalSession[]; connected: boolean };
const TerminalContext = createContext<TerminalContextValue | null>(null);

export function TerminalProvider({ children }: { children: ComponentChildren }) {
  const { client, connected } = useGateway();
  const { snapshot } = useSession();
  const [sessions] = useState(() => {
    const key = `gsv.terminal.v1:${JSON.stringify([snapshot.url, snapshot.username])}`;
    return new TerminalSessions({
      execute: (input, signal) => executeTerminalCommand(client, input, signal),
      cancel: (sessionId, signal) => cancelTerminalCommand(client, sessionId, signal),
    }, {
      read: () => window.sessionStorage.getItem(key),
      write: (value) => window.sessionStorage.setItem(key, value),
    });
  });
  const [rows, setRows] = useState(sessions.snapshot);
  useLayoutEffect(() => {
    const update = () => setRows(sessions.snapshot());
    const unsubscribe = sessions.subscribe(update);
    update();
    return unsubscribe;
  }, [sessions]);
  useLayoutEffect(() => { sessions.setConnected(connected); }, [sessions, connected]);
  useEffect(() => () => sessions.dispose(), [sessions]);
  return <TerminalContext.Provider value={{ sessions, rows, connected }}>{children}</TerminalContext.Provider>;
}

export function useTerminalSessions(): TerminalContextValue {
  const context = useContext(TerminalContext);
  if (!context) throw new Error("Terminal sessions need their signed-in owner.");
  return context;
}
