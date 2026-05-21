import type { SysTargetRegisterResult } from "@gsv/protocol/syscalls/system";
import { BrowserTargetShell } from "./browser-target-shell";
import type { GatewayClientLike } from "./gateway-client";
import type { WindowManager } from "./window-manager";

type BrowserTargetOptions = {
  gatewayClient: GatewayClientLike;
  windowManager: WindowManager;
};

const TARGET_IMPLEMENTS = [
  "fs.read",
  "fs.write",
  "fs.edit",
  "fs.delete",
  "fs.search",
  "fs.copy",
  "fs.transfer.stat",
  "fs.transfer.read",
  "fs.transfer.write",
  "shell.exec",
];
const TARGET_VERSION = "0.1.0";

export function createBrowserTargetProvider({
  gatewayClient,
  windowManager,
}: BrowserTargetOptions): () => void {
  let registeredConnectionId: string | null = null;
  const shell = new BrowserTargetShell(windowManager, gatewayClient);

  const unregisterRead = gatewayClient.onRequest("fs.read", (frame) => shell.read(frame));
  const unregisterWrite = gatewayClient.onRequest("fs.write", (frame) => shell.write(frame));
  const unregisterEdit = gatewayClient.onRequest("fs.edit", (frame) => shell.edit(frame));
  const unregisterDelete = gatewayClient.onRequest("fs.delete", (frame) => shell.delete(frame));
  const unregisterSearch = gatewayClient.onRequest("fs.search", (frame) => shell.search(frame));
  const unregisterCopy = gatewayClient.onRequest("fs.copy", (frame) => shell.copy(frame));
  const unregisterTransferStat = gatewayClient.onRequest("fs.transfer.stat", (frame) => shell.transferStat(frame));
  const unregisterTransferRead = gatewayClient.onRequest("fs.transfer.read", (frame) => shell.transferRead(frame));
  const unregisterTransferWrite = gatewayClient.onRequest("fs.transfer.write", (frame) => shell.transferWrite(frame));
  const unregisterShell = gatewayClient.onRequest("shell.exec", (frame) => shell.exec(frame));
  const unregisterStatus = gatewayClient.onStatus((status) => {
    if (status.state !== "connected" || !status.connectionId) {
      registeredConnectionId = null;
      shell.setTargetId(null);
      return;
    }
    if (registeredConnectionId === status.connectionId) {
      return;
    }
    registeredConnectionId = status.connectionId;
    shell.setTargetId(`browser:${status.connectionId}`);
    shell.warmup();
    void registerBrowserTarget(gatewayClient).catch((error) => {
      registeredConnectionId = null;
      console.warn("Failed to register browser target", error);
    });
  });

  return () => {
    unregisterRead();
    unregisterWrite();
    unregisterEdit();
    unregisterDelete();
    unregisterSearch();
    unregisterCopy();
    unregisterTransferStat();
    unregisterTransferRead();
    unregisterTransferWrite();
    unregisterShell();
    unregisterStatus();
    shell.dispose();
  };
}

async function registerBrowserTarget(gatewayClient: GatewayClientLike): Promise<void> {
  await gatewayClient.call<SysTargetRegisterResult>("sys.target.register", {
    label: "Browser Shell",
    description: "The active GSV web shell desktop, windows, apps, and browser-side automation.",
    platform: "browser-shell",
    version: TARGET_VERSION,
    implements: TARGET_IMPLEMENTS,
  });
}
