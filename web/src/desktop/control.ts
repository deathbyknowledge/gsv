import { ClientControlError, type ClientControl, type ControlCommand, type ControlHandler, type ControlResponse } from "../app/services/platform/ClientControl";
import { invoke } from "./bridge";

export type ControlEvent = { type: "request"; id: string; command: ControlCommand } | { type: "cancel"; id: string };
export type ControlReply = { type: "success"; response: ControlResponse } | { type: "error"; code: ClientControlError["code"] };

export function desktopControl(generation: string): ClientControl & { attach(): () => void } {
  const handlers = new Map<ControlCommand["type"], ControlHandler>();
  const active = new Map<string, { abort: AbortController; handler: ControlHandler | undefined }>();
  return {
    register(commands, handler) {
      for (const command of commands) handlers.set(command, handler);
      return () => {
        for (const command of commands) if (handlers.get(command) === handler) handlers.delete(command);
        for (const request of active.values()) if (request.handler === handler) request.abort.abort();
      };
    },
    attach() {
      if (!window.__TAURI__) return () => {};
      let disposed = false;
      const receive = async (event: ControlEvent) => {
        if (disposed) return;
        if (event.type === "cancel") { active.get(event.id)?.abort.abort(); return; }
        const abort = new AbortController();
        const handler = handlers.get(event.command.type);
        active.set(event.id, { abort, handler });
        const token = await lease;
        const checkpoint = async () => {
          const permitted = !disposed && !abort.signal.aborted && await invoke("control_active", { lease: token, id: event.id });
          if (!permitted || disposed || abort.signal.aborted || handlers.get(event.command.type) !== handler) {
            abort.abort();
            throw new ClientControlError("conflict");
          }
        };
        let reply: ControlReply;
        try {
          await checkpoint();
          if (!handler) throw new ClientControlError("unavailable");
          const response = await handler({ command: event.command, signal: abort.signal, checkpoint });
          await checkpoint();
          reply = { type: "success", response };
        } catch (error) {
          reply = { type: "error", code: error instanceof ClientControlError ? error.code : "unavailable" };
        }
        active.delete(event.id);
        if (!disposed) await invoke("control_reply", { lease: token, id: event.id, reply });
      };
      const updates = new window.__TAURI__.core.Channel<ControlEvent>((event) => { void receive(event).catch(() => {}); });
      const lease = invoke("control_attach", { generation, updates });
      void lease.catch(() => {});
      return () => {
        disposed = true;
        for (const request of active.values()) request.abort.abort();
        active.clear();
        void lease.then((token) => invoke("control_detach", { lease: token })).catch(() => {});
      };
    },
  };
}
