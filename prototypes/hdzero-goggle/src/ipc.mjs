import { lstat, chmod, unlink } from "node:fs/promises";
import net from "node:net";

const MAX_LINE_BYTES = 8 * 1024;
const COMMANDS = new Set(["ptt.toggle", "speech.toggle", "cancel"]);

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
  constructor(socketPath, { onCommand, getSnapshot, log = console.error }) {
    this.socketPath = socketPath;
    this.onCommand = onCommand;
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
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
          socket.destroy(new Error("IPC command exceeded limit"));
          return;
        }
        this.handleLine(line);
      }
      if (Buffer.byteLength(buffered) > MAX_LINE_BYTES) {
        socket.destroy(new Error("IPC command exceeded limit"));
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
    if (!message || !COMMANDS.has(message.type)) {
      return;
    }
    try {
      void Promise.resolve(this.onCommand(message.type)).catch((error) => {
        this.log(`[bridge] command failed: ${error instanceof Error ? error.message : "unknown error"}`);
      });
    } catch (error) {
      this.log(`[bridge] command failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  broadcast(snapshot) {
    for (const client of this.clients) {
      this.send(client, snapshot);
    }
  }

  send(socket, message) {
    if (!socket.destroyed && socket.writableLength <= MAX_LINE_BYTES * 8) {
      socket.write(`${JSON.stringify(message)}\n`);
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
