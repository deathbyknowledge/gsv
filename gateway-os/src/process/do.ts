import { Connection, ConnectionContext, Agent as Host } from "agents";

// Smart processes = agent loop state machine
export class Process extends Host<Env> {
  shouldSendProtocolMessages(_: Connection, __: ConnectionContext): boolean {
    return false;
  }
}
