import { createContext, type ComponentChildren } from "preact";
import { useContext, useEffect, useLayoutEffect, useMemo, useState } from "preact/hooks";
import { useViewActive } from "../navigation/ViewActivity";
import { useGateway } from "../gateway/GatewayProvider";
import { useSession } from "../session/SessionProvider";
import { cancelTerminalCommand, executeTerminalCommand } from "./backend/terminalService";
import { TerminalSessions, type TerminalSession } from "./terminalSessions";

type TerminalContextValue = { sessions: TerminalSessions; rows: readonly TerminalSession[]; connected: boolean };
const TerminalContext = createContext<Omit<TerminalContextValue, "rows"> | null>(null);

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
  useLayoutEffect(() => { sessions.setConnected(connected); }, [sessions, connected]);
  useEffect(() => () => sessions.dispose(), [sessions]);
  const value = useMemo(() => ({ sessions, connected }), [sessions, connected]);
  return <TerminalContext.Provider value={value}>{children}</TerminalContext.Provider>;
}

export function useTerminalSessions(): TerminalContextValue {
  const context = useContext(TerminalContext);
  if (!context) throw new Error("Terminal sessions need their signed-in owner.");
  const active = useViewActive();
  const { sessions } = context;
  const [rows, setRows] = useState(sessions.snapshot);
  useLayoutEffect(() => {
    if (!active) return;
    const update = () => setRows(sessions.snapshot());
    const unsubscribe = sessions.subscribe(update);
    update();
    return unsubscribe;
  }, [active, sessions]);
  return { ...context, rows: active ? sessions.snapshot() : rows };
}
