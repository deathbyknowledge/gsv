/**
 * KernelContext — the single shape passed to all syscall handlers.
 *
 * `identity` is undefined during sys.connect (pre-auth).
 * For all other handlers, the kernel guarantees it is present.
 */

import type { Connection } from "agents";
import type { ConnectionIdentity } from "@gsv/protocol/syscalls/system";
import type { AuthStore } from "./auth-store";
import type { CapabilityStore } from "./capabilities";
import type { ConfigStore } from "./config";
import type { DeviceRegistry } from "./devices";
import type { ProcessRegistry } from "./processes";
import type { AdapterStore } from "./adapter-store";
import type { RunRouteStore } from "./run-routes";
import type { ShellSessionStore } from "./shell-sessions";
import type { WorkspaceStore } from "./workspaces";
import type { PackageStore } from "./packages";
import type { AutomationStore } from "./automation";
import type { SignalWatchStore } from "./signal-watches";
import type { NotificationStore } from "./notifications";
import type { AppFrameContext } from "../protocol/app-frame";

export type KernelContext = {
  env: Env;
  auth: AuthStore;
  caps: CapabilityStore;
  config: ConfigStore;
  devices: DeviceRegistry;
  procs: ProcessRegistry;
  workspaces: WorkspaceStore;
  packages: PackageStore;
  adapters: AdapterStore;
  runRoutes: RunRouteStore;
  shellSessions: ShellSessionStore;
  automation: AutomationStore;
  signalWatches: SignalWatchStore;
  notifications?: NotificationStore;
  connection: Connection;
  identity?: ConnectionIdentity;
  processId?: string;
  appFrame?: AppFrameContext;
  serverVersion: string;
  broadcastToUid?: (uid: number, signal: string, payload?: unknown) => void;
  getAppRunner?: (uid: number, packageId: string) => unknown;
};
