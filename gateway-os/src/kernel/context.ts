/**
 * KernelContext — the single shape passed to all syscall handlers.
 *
 * `identity` is undefined during sys.connect (pre-auth).
 * For all other handlers, the kernel guarantees it is present.
 */

import type { Connection } from "agents";
import type { ConnectionIdentity } from "../syscalls/system";
import type { CapabilityStore } from "./capabilities";
import type { DeviceRegistry } from "./devices";
import type { ProcessRegistry } from "./processes";

export type KernelContext = {
  env: Env;
  caps: CapabilityStore;
  devices: DeviceRegistry;
  procs: ProcessRegistry;
  connection: Connection;
  identity?: ConnectionIdentity;
  serverVersion: string;
};
