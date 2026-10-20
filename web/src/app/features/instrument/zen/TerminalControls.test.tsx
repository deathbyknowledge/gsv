import { GSVClient } from "@humansandmachines/gsv/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayProvider } from "../../../services/gateway/GatewayProvider";
import { SessionProvider } from "../../../services/session/SessionProvider";
import { createSessionService } from "../../../services/session/sessionService";
import { TerminalProvider } from "../../../services/terminal/TerminalProvider";
import type { TerminalSession } from "../../../services/terminal/terminalSessions";
import { collectText, createTestRoot } from "../../../testing/testHarness";
import { TerminalControls } from "./TerminalControls";

const session: TerminalSession = {
  id: "row", scope: "chat", target: "studio", command: "ls", sessionId: "session", startedAt: 1, endedAt: null,
  status: "unavailable", output: "", truncated: false, error: "", actionError: "", note: null, actionNote: null,
  draft: "", inputOpen: false, action: null, stopRequested: false,
};

let root: ReturnType<typeof createTestRoot> | undefined;
afterEach(async () => { await root?.unmount(); root = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/* the controls read the interface language and the terminal sessions, so they render inside their providers */
async function shown(row: TerminalSession): Promise<string> {
  vi.stubGlobal("document", {});
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), location: { protocol: "https:", host: "example.com" },
    sessionStorage: { getItem: () => null, setItem: () => {} } });
  vi.spyOn(GSVClient.prototype, "getStatus").mockReturnValue({ state: "connected", url: null, username: null, connectionId: null, message: null });
  vi.spyOn(GSVClient.prototype, "onStatus").mockImplementation(() => () => {});
  let tree: ReturnType<typeof TerminalControls> | undefined;
  function Harness() { tree = TerminalControls({ session: row }); return null; }
  await root?.unmount();
  root = createTestRoot("Terminal controls");
  await root.render(<GatewayProvider><SessionProvider createService={(client) => ({ ...createSessionService(client), start: async () => {} })}>
    <TerminalProvider><Harness /></TerminalProvider>
  </SessionProvider></GatewayProvider>);
  return collectText(tree);
}

describe("terminal controls", () => {
  it("shows a failure the interface words itself, and one the target reported as sent", async () => {
    expect(await shown({ ...session, note: "sessionLost" })).toContain("The command’s session could not be recovered.");
    expect(await shown({ ...session, actionNote: "updateShip", error: "connection reset" })).toContain("Update Ship on this computer before running commands here.");
    expect(await shown({ ...session, error: "permission denied" })).toContain("permission denied");
  });
});
