/** Explicitly provisioned environments; a terminal instance is never restarted. */
export type CloudInstanceState = "starting" | "ready" | "stopping" | "stopped" | "failed";
export type CloudInstanceKind = "browser" | "linux";

export type CloudInstance = {
  instanceId: string;
  targetId: string;
  startRequestId: string;
  ownerUid: number;
  templateId: string;
  templateRevision: string;
  kind: CloudInstanceKind;
  implements: string[];
  label: string;
  state: CloudInstanceState;
  revision: number;
  profileId?: string;
  isolated?: boolean;
  createdAt: number;
  readyAt?: number;
  expiresAt: number;
  stoppedAt?: number;
  reason?: string;
  diagnosticRef?: string;
};

export type InstanceTemplate = {
  templateId: string;
  revision: string;
  kind: CloudInstanceKind;
  label: string;
  description: string;
  implements: string[];
  defaultLifetimeSeconds: number;
  maxLifetimeSeconds: number;
  capacityUnits: number;
};

export type InstanceUsage = {
  periodStartsAt: number;
  periodEndsAt: number;
  usedSeconds: number;
  reservedSeconds: number;
  limitSeconds: number;
  activeInstances: number;
  concurrentLimit: number;
};

export type SysInstanceCatalogArgs = Record<string, never>;
export type SysInstanceCatalogResult = { templates: InstanceTemplate[]; usage: InstanceUsage };
export type SysInstanceStartArgs = {
  requestId: string;
  templateId: string;
  label?: string;
  lifetimeSeconds?: number;
  profileId?: string;
  /** Create a separate instance instead of reusing the account's current browser. */
  fresh?: boolean;
};
export type SysInstanceStartResult = { instance: CloudInstance; disposition: "created" | "reused" };
export type SysInstanceListArgs = { includeTerminal?: boolean };
export type SysInstanceListResult = { instances: CloudInstance[]; handoffs: BrowserHandoff[]; usage: InstanceUsage };
export type InstanceSelector = { instanceId: string; startRequestId?: never } | { startRequestId: string; instanceId?: never };
export type SysInstanceGetArgs = InstanceSelector;
export type SysInstanceGetResult = { instance: CloudInstance | null };
export type SysInstanceStopArgs = InstanceSelector;
export type SysInstanceStopResult = { instance: CloudInstance | null };

export type BrowserProfile = {
  profileId: string;
  ownerUid: number;
  label: string;
  createdAt: number;
  revision: number;
  state: "active" | "deleting" | "deleted";
  saveStatus: "empty" | "saved" | "failed";
  savedAt?: number;
  activeInstanceId?: string;
  diagnosticRef?: string;
};

export type SysBrowserProfileCreateArgs = { requestId: string; label: string };
export type SysBrowserProfileCreateResult = { profile: BrowserProfile };
export type SysBrowserProfileListArgs = Record<string, never>;
export type SysBrowserProfileListResult = { profiles: BrowserProfile[] };
export type SysBrowserProfileGetArgs = { profileId: string };
export type SysBrowserProfileGetResult = { profile: BrowserProfile | null };
export type SysBrowserProfileDeleteArgs = { profileId: string };
export type SysBrowserProfileDeleteResult = { profile: BrowserProfile | null };

export type BrowserHandoff = {
  requestId: string;
  instanceId: string;
  tabId: number;
  activeTabId?: number;
  purpose: string;
  site: string;
  state: "pending" | "active" | "completed" | "cancelled" | "expired" | "failed";
  revision: number;
  createdAt: number;
  expiresAt: number;
  responsibilityId?: string;
  completedAt?: number;
  reason?: string;
  diagnosticRef?: string;
};

export type SysBrowserHandoffRequestArgs = {
  requestId: string;
  instanceId: string;
  tabId: number;
  purpose: string;
  responsibilityId?: string;
};
export type SysBrowserHandoffRequestResult = { handoff: BrowserHandoff; actionPath: string };
export type SysBrowserHandoffGetArgs = { instanceId: string; requestId: string };
export type SysBrowserHandoffGetResult = { handoff: BrowserHandoff | null };
export type SysBrowserHandoffCancelArgs = SysBrowserHandoffGetArgs;
export type SysBrowserHandoffCancelResult = SysBrowserHandoffGetResult;

export type SysBrowserHandoffOpenArgs = SysBrowserHandoffGetArgs;
export type SysBrowserHandoffOpenResult = { handoff: BrowserHandoff };
export type SysBrowserHandoffFinishArgs = SysBrowserHandoffGetArgs;
export type SysBrowserHandoffFinishResult = { handoff: BrowserHandoff };
export type SysBrowserFrameArgs = { instanceId: string; tabId?: number };
export type SysBrowserWatchArgs = SysBrowserFrameArgs;
export type SysBrowserWatchResult = { watchId: string; version: 1 };
export type BrowserPointer = { tabId: number; x: number; y: number; actor: "ship" | "human"; clickedAt?: number };
/** The image travels in the response body, never in history or a provider URL. */
export type SysBrowserFrameResult = {
  instance: CloudInstance;
  handoff?: BrowserHandoff;
  tabId: number;
  documentId: string;
  pointer?: BrowserPointer;
  tabs: Array<{ id: number; title: string; url: string }>;
  width: number;
  height: number;
  contentType: "image/jpeg";
};
export type SysBrowserInputArgs = { instanceId: string; tabId: number; documentId: string; handoffRequestId?: string };
export type SysBrowserInputResult = { accepted: true };
/** Human-only input travels as a JSON body, outside syscall argument ledgers. */
export type BrowserHumanInput =
  | { kind: "tab"; tabId: number }
  | { kind: "click"; x: number; y: number }
  | { kind: "scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "key"; key: string; modifiers?: number }
  | { kind: "text"; text: string };
