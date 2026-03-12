export type ProcessIdentity = {
  uid: number;
  gid: number;
  gids: number[];
  username: string;
  home: string;
};

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

export type ConnectArgs = {
  protocol: number;
  client: {
    id: string;
    version: string;
    platform: string;
    role: "user" | "driver" | "service";
    channel?: string;
  };
  driver?: {
    implements: string[];
  };
  auth?: {
    username: string;
    password?: string;
    token?: string;
  };
};

export type ConnectResult = {
  protocol: number;
  server: {
    version: string;
    connectionId: string;
  };
  identity: ConnectionIdentity;
  syscalls: string[];
  signals: string[];
};

export type UserPermissions = {
  uid: number;
  grants: string[];
  denials: string[];
};

// -- sys.config.get / sys.config.set -----------------------------------------

export type SysConfigGetArgs = {
  key?: string;
};

export type SysConfigEntry = {
  key: string;
  value: string;
};

export type SysConfigGetResult = {
  entries: SysConfigEntry[];
};

export type SysConfigSetArgs = {
  key: string;
  value: string;
};

export type SysConfigSetResult = {
  ok: true;
};
