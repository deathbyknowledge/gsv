import type { GatewayDriverClient } from "./gateway-client";
import type { GatewayRequestFrame } from "../shared/frames";
import type { DriverHandler } from "../target/types";
import { createBrowserCommands } from "../target/commands";
import { BrowserFsDriver, BrowserTargetFileSystem } from "../target/fs";
import { createRuntimeFileSystem } from "../target/runtime-fs";
import { BrowserTargetShell } from "../target/shell";

export type BrowserTargetDriver = {
  handle: DriverHandler;
};

export function createBrowserTargetDriver(client: GatewayDriverClient): BrowserTargetDriver {
  const fs = new BrowserTargetFileSystem(createRuntimeFileSystem());
  const fsDriver = new BrowserFsDriver(fs, client);
  const shell = new BrowserTargetShell(fs, createBrowserCommands());

  return {
    async handle(frame: GatewayRequestFrame): Promise<unknown> {
      if (frame.call === "shell.exec") {
        return await shell.exec(frame.args);
      }
      if (frame.call.startsWith("fs.")) {
        return await fsDriver.handle(frame.call, frame.args);
      }
      throw new Error(`Unsupported browser target syscall: ${frame.call}`);
    },
  };
}
