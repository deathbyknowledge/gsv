import type { ToolDefinition } from ".";

export type ProcessIdentity = {
  uid: number;
  gid: number;
  gids: number[];
  username: string;
  home: string;
};

export type ConnectionIdentity = UserIdentity | NodeIdentity | ServiceIdentity;

export type UserIdentity = {
  role: "user";
  process: ProcessIdentity;
  capabilities: string[];
};

export type NodeIdentity = {
  role: "driver";
  process: ProcessIdentity;
  capabilities: string[];
  node: string;
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
    node?: string;
    channel?: string;
  };
  tools?: ToolDefinition[];
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
