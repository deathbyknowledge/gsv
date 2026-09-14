import { WebSocket } from "undici";
import { GSVClient, type GsvWebSocketConstructor } from "@humansandmachines/gsv/client";

class FixtureWebSocket extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, { protocols, headers: { "user-agent": "gsv-upgrade-acceptance/1.0" } });
  }
}

export function createFixtureClient() {
  // SAFETY: Undici supplies the browser WebSocket interface consumed by GSVClient.
  return new GSVClient({ WebSocket: FixtureWebSocket as GsvWebSocketConstructor, defaultRequestTimeoutMs: 45_000 });
}
