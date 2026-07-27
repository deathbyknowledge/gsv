import type { ProcessIdentity } from "./system";

export type UserAdminCreateArgs = {
  action: "create";
  username: string;
  password: string;
  gecos?: string;
};

export type UserAdminPermissionsArgs = {
  action: "permissions";
  username: string;
  grant?: string[];
  revoke?: string[];
  addGroups?: string[];
  removeGroups?: string[];
};

export type UserAdminArgs = UserAdminCreateArgs | UserAdminPermissionsArgs;

export type UserAdminCreateResult = {
  action: "create";
  account: ProcessIdentity;
  personalAgent: ProcessIdentity;
};

export type UserAdminGroupSummary = {
  name: string;
  gid: number;
  primary: boolean;
};

export type UserAdminPermissionsResult = {
  action: "permissions";
  user: {
    username: string;
    uid: number;
    gid: number;
  };
  groups: UserAdminGroupSummary[];
  directCapabilities: string[];
  effectiveCapabilities: string[];
  changed: boolean;
};

export type UserAdminResult = UserAdminCreateResult | UserAdminPermissionsResult;
