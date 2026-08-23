import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";

export type ConnectionIdentity = UserIdentity | DeviceIdentity | ServiceIdentity;

export type UserIdentity = {
  role: "user";
  process: ProcessIdentity;
  capabilities: string[];
};

export type DeviceIdentity = {
  role: "driver";
  process: ProcessIdentity;
  capabilities: string[];
  device: string;
  implements: string[];
};

export type ServiceIdentity = {
  role: "service";
  process: ProcessIdentity;
  capabilities: string[];
  channel: string;
};
