import type { ToolDefinition } from ".";

export type ConnectionIdentity = UserIdentity | NodeIdentity | ServiceIdentity;

export type UserIdentity = {
  uid: string;
  role: "user";
  capabilities: string[];
}

export type NodeIdentity = {
  uid: string;
  role: "driver";
  capabilities: string[];
  node: string;
}

export type ServiceIdentity = {
  uid: string;
  role: "service";
  capabilities: string[];
  channel: string;
}


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
  uid: string;
  grants: string[];
  denials: string[];
};
