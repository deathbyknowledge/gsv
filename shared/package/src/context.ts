export type PackageMetaBinding = {
  packageName: string;
  packageId: string;
  routeBase: string | null;
};

export type PackageViewerBinding = {
  uid: number;
  username: string;
};

export type PackageAppSessionBinding = {
  sessionId: string;
  clientId: string;
  rpcBase: string;
  expiresAt: number;
};

export type KernelClientLike = {
  request<T = unknown>(call: string, args?: unknown): Promise<T>;
};

export type PackageSqlBindingValue =
  | string
  | number
  | boolean
  | null;

export type PackageStorageSqlBinding = {
  exec<T extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    ...bindings: PackageSqlBindingValue[]
  ): Promise<T[]>;
};

export type PackageStorageBinding = {
  sql: PackageStorageSqlBinding;
};

export type PackageDaemonSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "after"; afterMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number };

export type PackageDaemonInvocation = {
  kind: "schedule";
  key: string;
  scheduledAt: number;
  firedAt: number;
};

export type PackageDaemonScheduleRecord = {
  key: string;
  rpcMethod: string;
  schedule: PackageDaemonSchedule;
  payload?: unknown;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  nextRunAt?: number | null;
  runningAt?: number | null;
  lastRunAt?: number | null;
  lastStatus?: "ok" | "error" | null;
  lastError?: string | null;
  lastDurationMs?: number | null;
};

export type PackageDaemonContext = {
  upsertRpcSchedule(
    input: {
      key: string;
      rpcMethod: string;
      schedule: PackageDaemonSchedule;
      payload?: unknown;
      enabled?: boolean;
    },
  ): Promise<PackageDaemonScheduleRecord>;
  removeRpcSchedule(key: string): Promise<{ removed: boolean }>;
  listRpcSchedules(): Promise<PackageDaemonScheduleRecord[]>;
  trigger?: PackageDaemonInvocation;
};

export type PackageSignalWatchInfo = {
  id: string;
  key?: string;
  state?: unknown;
  createdAt?: number;
};

export type PackageSignalContext = {
  signal: string;
  payload: unknown;
  sourcePid?: string | null;
  watch: PackageSignalWatchInfo;
};
