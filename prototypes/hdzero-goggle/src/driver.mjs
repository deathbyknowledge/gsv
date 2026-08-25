import { GSVClient } from "@humansandmachines/gsv/client";

import { WearableFilesystem } from "./filesystem.mjs";
import { connectionFailureReason, ReconnectSupervisor } from "./reconnect.mjs";
import { WearableShell } from "./shell.mjs";

const IMPLEMENTS = [
  "fs.read",
  "fs.write",
  "fs.edit",
  "fs.delete",
  "fs.search",
  "fs.copy",
  "fs.transfer.stat",
  "fs.transfer.send",
  "fs.transfer.receive",
  "shell.exec",
];

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Stopped"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function required(value, name) {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required for the wearable device target`);
  }
  return normalized;
}

export class WearableDriver {
  constructor(config, {
    getState,
    getPresentation,
    onActivity = () => {},
    onPresent = () => {},
    onStatus,
    log = console.error,
  }) {
    this.config = {
      url: required(config.url, "GSV_GATEWAY_URL"),
      username: required(config.username, "GSV_USERNAME"),
      token: required(config.token, "GSV_DEVICE_TOKEN"),
      deviceId: config.deviceId?.trim() || "hdzero-g2-emulator",
      rootPath: required(config.rootPath, "GSV_DEVICE_ROOT"),
      firmwareAppRoot: config.firmwareAppRoot?.trim() || undefined,
    };
    this.onActivity = onActivity;
    this.onPresent = onPresent;
    this.getPresentation = getPresentation;
    this.onStatusChange = onStatus;
    this.log = log;
    this.client = new GSVClient({ WebSocket: globalThis.WebSocket });
    this.driver = this.client.driver({
      deviceId: this.config.deviceId,
      platform: "hdzero-emulator",
      version: "0.3.0",
    });
    this.filesystem = new WearableFilesystem({
      rootPath: this.config.rootPath,
      firmwareAppRoot: this.config.firmwareAppRoot,
      deviceId: this.config.deviceId,
      getState,
    });
    this.shell = null;
    for (const call of IMPLEMENTS) {
      this.driver.implement(call, async (request, context) => (
        await this.handle(request, context)
      ));
    }
    this.connection = new ReconnectSupervisor({
      isConnected: () => this.client.isConnected(),
      connect: () => this.driver.connect({
        url: this.config.url,
        username: this.config.username,
        token: this.config.token,
      }),
      onRetry: (error, retryMs) => {
        const reason = connectionFailureReason(error, [this.config.token]);
        this.log(`[driver] connect failed: ${reason}; retrying in ${retryMs}ms`);
      },
    });
    this.unsubscribeStatus = this.client.onStatus((status) => {
      if (status.state === "connected") {
        this.onStatusChange("online", "Filesystem and pseudo-shell target ready", this.config.deviceId);
      } else if (status.state === "connecting") {
        this.onStatusChange("connecting", "Connecting machine target", this.config.deviceId);
      } else {
        this.onStatusChange("offline", "Machine target offline", this.config.deviceId);
        this.connection.disconnected();
      }
    });
  }

  async start() {
    await this.filesystem.initialize();
    this.shell = new WearableShell({
      filesystem: this.filesystem,
      onPresent: this.onPresent,
      getPresentation: this.getPresentation,
      onActivity: this.onActivity,
    });
    return await this.connection.start();
  }

  async handle(request, context) {
    if (request.body && request.call !== "fs.transfer.receive") {
      await request.body.stream.cancel(`${request.call} does not accept a request body`).catch(() => {});
    }
    const labels = {
      "fs.read": "Wearable filesystem read",
      "fs.write": "Wearable filesystem write",
      "fs.edit": "Wearable filesystem edit",
      "fs.delete": "Wearable filesystem delete",
      "fs.search": "Wearable filesystem search",
      "fs.copy": "Wearable filesystem copy",
      "fs.transfer.stat": "Wearable file transfer inspection",
      "fs.transfer.send": "Wearable file transfer send",
      "fs.transfer.receive": "Wearable file transfer receive",
      "shell.exec": "Wearable pseudo-shell command",
    };
    this.onActivity(labels[request.call] || "Wearable device request");
    if (request.call === "fs.read") {
      return await this.filesystem.read(request.args);
    }
    if (request.call === "fs.write") {
      return await this.filesystem.write(request.args);
    }
    if (request.call === "fs.edit") {
      return await this.filesystem.edit(request.args);
    }
    if (request.call === "fs.delete") {
      return await this.filesystem.delete(request.args);
    }
    if (request.call === "fs.search") {
      return await this.filesystem.search(request.args, context.abortSignal);
    }
    if (request.call === "fs.copy") {
      return await this.filesystem.copy(request.args);
    }
    if (request.call === "fs.transfer.stat") {
      return await this.filesystem.transferStat(request.args);
    }
    if (request.call === "fs.transfer.send") {
      return await this.filesystem.transferSend(request.args);
    }
    if (request.call === "fs.transfer.receive") {
      return await this.filesystem.transferReceive(
        request.args,
        request.body,
        context.abortSignal,
      );
    }
    if (request.call === "shell.exec") {
      return { data: await this.shell.execute(request.args, context.abortSignal) };
    }
    return { data: { ok: false, error: `Unsupported wearable syscall: ${request.call}` } };
  }

  async stop() {
    this.unsubscribeStatus();
    const stopped = this.connection.stop();
    this.driver.close();
    await stopped;
  }
}

export class MockWearableDriver {
  constructor({ deviceId = "hdzero-g2-emulator" } = {}, { onStatus }) {
    this.deviceId = deviceId;
    this.onStatus = onStatus;
    this.stopped = false;
  }

  async start() {
    this.onStatus("connecting", "Starting mock machine target", this.deviceId);
    await delay(120);
    if (!this.stopped) {
      this.onStatus("online", "Filesystem and pseudo-shell mock ready", this.deviceId);
    }
  }

  async stop() {
    this.stopped = true;
    this.onStatus("offline", "Mock machine target stopped", this.deviceId);
  }
}

export class DisabledWearableDriver {
  constructor({ deviceId = "hdzero-g2-emulator" } = {}, { onStatus }) {
    this.deviceId = deviceId;
    this.onStatus = onStatus;
  }

  async start() {
    this.onStatus("offline", "Set GSV_DEVICE_TOKEN to expose this machine", this.deviceId);
  }

  async stop() {}
}
