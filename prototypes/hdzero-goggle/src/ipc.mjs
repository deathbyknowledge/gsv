import { lstat, chmod, unlink } from "node:fs/promises";
import net from "node:net";

const MAX_ACTION_BYTES = 1024;
const MAX_SNAPSHOT_BYTES = 32 * 1024;
const ACTIONS = new Set([
  "voice.toggle",
  "speech.toggle",
  "request.cancel",
  "view.next",
  "view.previous",
  "view.open",
]);
const VIEWS = new Set(["conversation", "activity", "device"]);

async function removeStaleSocket(socketPath) {
  try {
    const stat = await lstat(socketPath);
    if (!stat.isSocket()) {
      throw new Error(`Refusing to replace non-socket path: ${socketPath}`);
    }
    await unlink(socketPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

export class IpcServer {
  constructor(socketPath, { onAction, getSnapshot, log = console.error }) {
    this.socketPath = socketPath;
    this.onAction = onAction;
    this.getSnapshot = getSnapshot;
    this.log = log;
    this.clients = new Set();
    this.server = null;
  }

  async start() {
    await removeStaleSocket(this.socketPath);
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    await chmod(this.socketPath, 0o600);
  }

  accept(socket) {
    socket.setEncoding("utf8");
    this.clients.add(socket);
    let buffered = "";
    this.send(socket, this.getSnapshot());
    socket.on("data", (chunk) => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_ACTION_BYTES) {
          socket.destroy(new Error("IPC action exceeded limit"));
          return;
        }
        this.handleLine(line);
      }
      if (Buffer.byteLength(buffered) > MAX_ACTION_BYTES) {
        socket.destroy(new Error("IPC action exceeded limit"));
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => this.clients.delete(socket));
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || !ACTIONS.has(message.type)) {
      return;
    }
    if (message.type === "view.open" && !VIEWS.has(message.view)) {
      return;
    }
    try {
      const action = message.type === "view.open"
        ? { type: message.type, view: message.view }
        : { type: message.type };
      void Promise.resolve(this.onAction(action)).catch((error) => {
        this.log(`[bridge] action failed: ${error instanceof Error ? error.message : "unknown error"}`);
      });
    } catch (error) {
      this.log(`[bridge] action failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  broadcast(snapshot) {
    for (const client of this.clients) {
      this.send(client, snapshot);
    }
  }

  send(socket, message) {
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > MAX_SNAPSHOT_BYTES) {
      socket.destroy(new Error("IPC snapshot exceeded limit"));
    } else if (!socket.destroyed && socket.writableLength <= MAX_SNAPSHOT_BYTES * 2) {
      socket.write(line);
    } else if (!socket.destroyed) {
      socket.destroy(new Error("IPC client stopped reading snapshots"));
    }
  }

  async stop() {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
    await removeStaleSocket(this.socketPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}
