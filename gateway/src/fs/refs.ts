import type { AuthStore } from "../kernel/auth-store";
import type { CapabilityStore } from "../kernel/capabilities";
import type { ConfigStore } from "../kernel/config";
import type { DeviceRegistry } from "../kernel/devices";
import type { ProcessRegistry } from "../kernel/processes";

export type KernelRefs = {
  auth: AuthStore;
  procs: ProcessRegistry;
  devices: DeviceRegistry;
  caps: CapabilityStore;
  config: ConfigStore;
};
