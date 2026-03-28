import type {
  AppHostKind,
  AppSession,
  AppSurfaceKind,
} from "../app-runtime/contracts";

export type SysAppOpenThreadTarget = {
  pid?: string;
  cwd?: string;
  workspaceId?: string | null;
};

export type SysAppOpenHostTarget = {
  cwd?: string;
  workspaceId?: string | null;
};

export type SysAppOpenArgs = {
  appId: string;
  host: {
    kind: AppHostKind;
    instanceId: string;
  };
  surface?: {
    kind: AppSurfaceKind;
    name: string;
  };
  target?: {
    thread?: SysAppOpenThreadTarget | null;
    host?: SysAppOpenHostTarget | null;
  };
};

export type SysAppOpenResult = {
  session: AppSession;
};
