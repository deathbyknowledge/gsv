export type AdministrationMode = "access" | "settings";
export type SettingsPanelId = "runtime" | "advanced";
export type TokenKind = "node" | "service" | "user";
export type SettingKind = "text" | "textarea" | "password" | "number" | "checkbox" | "select" | "readonly" | "json";

export type ModelProfile = {
  id: string;
  name: string;
  values: Record<string, string>;
  createdAt: number;
  updatedAt: number;
};

export type ConfigEntry = {
  key: string;
  value: string;
  scopeLabel: string;
  pathLabel: string;
};

export type AccessToken = {
  tokenId: string;
  uid: number;
  kind: TokenKind;
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

export type CreatedAccessToken = {
  tokenId: string;
  token: string;
  tokenPrefix: string;
  uid: number;
  kind: TokenKind;
  label: string | null;
  allowedRole: string | null;
  allowedDeviceId: string | null;
  createdAt: number;
  expiresAt: number | null;
};

export type IdentityLink = {
  adapter: string;
  accountId: string;
  actorId: string;
  uid: number;
  createdAt: number;
  linkedByUid: number;
};

export type AdministrationViewer = {
  uid: number;
  username: string;
  canEditSystemConfig: boolean;
  canEditUserAiConfig: boolean;
  userAiPrefix: string;
};

export type AdministrationState = {
  viewer: AdministrationViewer;
  configEntries: ConfigEntry[];
  configValues: Record<string, string>;
  tokens: AccessToken[];
  links: IdentityLink[];
};

export type SaveConfigEntry = {
  key: string;
  value: string;
};

export type CreateAccessTokenArgs = {
  kind: TokenKind;
  label?: string;
  allowedDeviceId?: string;
  expiresAt?: number | null;
};

export type CreateAccessTokenResult = {
  state: AdministrationState;
  token: CreatedAccessToken;
};

export type RevokeAccessTokenArgs = {
  tokenId: string;
  reason?: string;
};

export type ConsumeLinkCodeArgs = {
  code: string;
};

export type CreateIdentityLinkArgs = {
  adapter: string;
  accountId: string;
  actorId: string;
};

export type RemoveIdentityLinkArgs = {
  adapter: string;
  accountId: string;
  actorId: string;
};

export type ApplyConfigArgs = {
  entries: SaveConfigEntry[];
};

export type SettingField = {
  key: string;
  label: string;
  description: string;
  kind: SettingKind;
  placeholder?: string;
  rows?: number;
  options?: Array<{ value: string; label: string }>;
};
