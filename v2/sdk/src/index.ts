import { GsvSocket, type ConnectOptions } from "./socket.ts";

export { GsvRequestError, GsvSocket, type ConnectOptions } from "./socket.ts";

/** Connects to one owner's control socket and resolves once the owner answered `connect`. */
export async function connect(options: ConnectOptions): Promise<GsvSocket> {
  const socket = new GsvSocket(options);
  await socket.open();
  return socket;
}
