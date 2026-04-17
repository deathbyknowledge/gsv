export type ControlTabId = "config" | "access" | "advanced";
export type ControlConfigSectionId = "ai" | "profiles" | "shell" | "server" | "processes" | "automation";
export type ControlTokenKind = "node" | "service" | "user";

export type ControlConfigEntry = {
  key: string;
  value: string;
  scopeLabel: string;
  pathLabel: string;
};

export type ControlToken = {
  tokenId: string;
  uid: number;
  kind: ControlTokenKind;
  label: string | null;
  tokenPrefix: string;
  allowedRole: string | null;
  allowedDeviceId: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
};

export type ControlCreatedToken = {
  tokenId: string;
  token: string;
  tokenPrefix: string;
  uid: number;
  kind: ControlTokenKind;
  label: string | null;
  allowedRole: string | null;
  allowedDeviceId: string | null;
  createdAt: number;
  expiresAt: number | null;
};

export type ControlLink = {
  adapter: string;
  accountId: string;
  actorId: string;
  uid: number;
  createdAt: number;
  linkedByUid: number;
};

export type ControlViewer = {
  uid: number;
  username: string;
  canEditSystemConfig: boolean;
  canEditUserAiConfig: boolean;
  userAiPrefix: string;
};

export type ControlState = {
  viewer: ControlViewer;
  configEntries: ControlConfigEntry[];
  configValues: Record<string, string>;
  tokens: ControlToken[];
  links: ControlLink[];
};

export type SaveEntryArgs = {
  key: string;
  value: string;
};

export type CreateTokenArgs = {
  kind: ControlTokenKind;
  label?: string;
  allowedDeviceId?: string;
  expiresAt?: number | null;
};

export type RevokeTokenArgs = {
  tokenId: string;
  reason?: string;
};

export type ConsumeLinkCodeArgs = {
  code: string;
};

export type CreateLinkArgs = {
  adapter: string;
  accountId: string;
  actorId: string;
};

export type UnlinkArgs = {
  adapter: string;
  accountId: string;
  actorId: string;
};

export type ApplyRawConfigArgs = {
  entries: SaveEntryArgs[];
};

export type CreateTokenResult = {
  state: ControlState;
  token: ControlCreatedToken;
};

export interface ControlBackend {
  loadState(args?: Record<string, never>): Promise<ControlState>;
  saveEntry(args: SaveEntryArgs): Promise<ControlState>;
  createToken(args: CreateTokenArgs): Promise<CreateTokenResult>;
  revokeToken(args: RevokeTokenArgs): Promise<ControlState>;
  consumeLinkCode(args: ConsumeLinkCodeArgs): Promise<ControlState>;
  createLink(args: CreateLinkArgs): Promise<ControlState>;
  unlink(args: UnlinkArgs): Promise<ControlState>;
  applyRawConfig(args: ApplyRawConfigArgs): Promise<ControlState>;
}
