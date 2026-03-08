import {
  Connection,
  ConnectionContext,
  Agent as Host,
  WSMessage,
  getCurrentAgent,
} from "agents";
import type { Frame } from "../protocol/frames";



// Manages the whole OS
export class Kernel extends Host<Env> {
  // we implement our own ws protocol so we silence the Agents SDK protocol messages
  shouldSendProtocolMessages(_: Connection, __: ConnectionContext): boolean {
    return false;
  }

  onConnect(connection: Connection): void {
    connection.setState({ step: 'connect' });
  }

  onMessage(_: Connection<unknown>, message: WSMessage): void {
    if (typeof message !== "string") {
      // todo: binary frames (transfers)
    } else {
      const frame: Frame = JSON.parse(message);
      const ok = ["req", "res", "sig"].includes(frame.type);
      // TODO: send the error instead of throwing
      if (!ok) throw new Error("Invalid frame");
      // handle frame
      switch (frame.type) {
        case "req":
          this.recvReq(frame);
        case "res":
          this.recvRes(frame.id, frame.ok, frame.data, frame.error);
        case "sig":
        // TODO: Should we receive signals? probably yes
      }
    }
  }

  recvReq(frame: RequestFrame): void {
    // steps for a connection (which can be a client owned by a user),
    // a node (from a physical machine owned by a user, maybe publicly available)
    // or a channel (from a service)
    // to receive a request:
    // 1. WS established
    // 2. client must send Hello frame
    // 3. kernel must send HelloOk frame if auth is OK. but could be that the client is not authenticated

    
  }
}
