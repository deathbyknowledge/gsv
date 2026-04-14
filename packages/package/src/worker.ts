export type PackageWindowMeta = {
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
};

export type PackageCapabilityMeta = {
  kernel?: string[];
  outbound?: string[];
};

export type PackageMeta = {
  displayName: string;
  description?: string;
  icon?: string;
  window?: PackageWindowMeta;
  capabilities?: PackageCapabilityMeta;
};

export type TaskScheduleSpec = {
  at?: number;
  afterMs?: number;
  everyMs?: number;
};

export type TaskScheduleOptions = {
  key?: string;
};

export type PackageBaseContext = {
  meta: {
    packageName: string;
    packageId: string;
    routeBase: string | null;
  };
  package: {
    sqlExec(statement: string, params?: unknown[]): Promise<void>;
    sqlQuery<T = Record<string, unknown>>(statement: string, params?: unknown[]): Promise<T[]>;
    runTask(name: string, payload?: unknown): Promise<void>;
    scheduleTask(
      name: string,
      spec: TaskScheduleSpec,
      payload?: unknown,
      options?: TaskScheduleOptions,
    ): Promise<void>;
    cancelTaskSchedule(name: string, options?: TaskScheduleOptions): Promise<void>;
  };
  kernel: {
    request<T = unknown>(call: string, args?: unknown): Promise<T>;
  };
};

export type PackageSetupContext = PackageBaseContext;

export type PackageCommandContext = PackageBaseContext & {
  argv: string[];
  stdin: {
    text(): Promise<string>;
  };
  stdout: {
    write(text: string): Promise<void>;
  };
  stderr: {
    write(text: string): Promise<void>;
  };
};

export type TaskTriggerKind = "manual" | "schedule" | "app" | "command";

export type PackageTaskContext = PackageBaseContext & {
  taskName: string;
  trigger: {
    kind: TaskTriggerKind;
    scheduledAt?: number;
  };
  payload: unknown;
};

export type PackageAppContext = PackageBaseContext;

export type PackageAppSignalContext = PackageAppContext & {
  signal: string;
  payload: unknown;
  sourcePid?: string | null;
  watch: {
    id: string;
    key?: string;
    state?: unknown;
    createdAt?: number;
  };
};

export type PackageBrowserAppDefinition = {
  entry: string;
};

export type PackageSetupHandler = (
  ctx: PackageSetupContext,
) => Promise<void> | void;

export type PackageCommandHandler = (
  ctx: PackageCommandContext,
) => Promise<void> | void;

export type PackageTaskHandler = (
  ctx: PackageTaskContext,
) => Promise<void> | void;

export type PackageAppDefinition = {
  browser?: PackageBrowserAppDefinition;
  assets?: string[];
  fetch?(request: Request, ctx: PackageAppContext): Promise<Response> | Response;
  onSignal?(ctx: PackageAppSignalContext): Promise<void> | void;
};

export type PackageDefinition = {
  meta: PackageMeta;
  setup?: PackageSetupHandler;
  commands?: Record<string, PackageCommandHandler>;
  app?: PackageAppDefinition;
  tasks?: Record<string, PackageTaskHandler>;
};

export function definePackage<const T extends PackageDefinition>(definition: T): T {
  return definition;
}
