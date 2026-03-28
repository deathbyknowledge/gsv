import type { ProcWorkspaceKind } from "../syscalls/proc";

export type AppHostKind = "window" | "shell" | "agent" | "webview";
export type AppSurfaceKind = "renderer" | "command";

export type AppSessionHost = {
  kind: AppHostKind;
  instanceId: string;
};

export type AppSessionSurface = {
  kind: AppSurfaceKind;
  name: string;
};

export type AppThreadSession = {
  pid: string;
  cwd: string;
  workspaceId: string | null;
};

export type AppWorkspaceAccess = "read" | "read-write";

export type AppWorkspaceSession = {
  workspaceId: string;
  root: string;
  cwd: string;
  kind: ProcWorkspaceKind;
  ownerUid: number;
};

export type AppBackendInstanceScope = "host" | "workspace" | "shared";

export type AppBackendBinding =
  | {
      kind: "kernel";
      syscalls: string[];
    }
  | {
      kind: "thread";
      thread: AppThreadSession;
    }
  | {
      kind: "workspace";
      access: AppWorkspaceAccess;
      workspace: AppWorkspaceSession;
    }
  | {
      kind: "service";
      binding: string;
      capability: string;
      status: "configured" | "missing";
    };

export type AppNoneBackend = {
  kind: "none";
  state: "not-required";
  bindings: readonly [];
};

export type AppDynamicWorkerBackend = {
  kind: "dynamic-worker";
  state: "ready" | "missing_loader";
  loaderBinding: "APP_BACKENDS";
  loaderMethod: "get";
  workerName: string;
  entrypoint: string;
  lifecycle: AppBackendInstanceScope;
  instanceKey: string;
  network: "none" | "gateway";
  bindings: AppBackendBinding[];
};

export type AppBackendSession = AppNoneBackend | AppDynamicWorkerBackend;

export type AppSession = {
  sessionId: string;
  appId: string;
  host: AppSessionHost;
  surface: AppSessionSurface;
  ownerUid: number | null;
  thread: AppThreadSession | null;
  workspace: AppWorkspaceSession | null;
  backend: AppBackendSession;
};

export type AppWindowSession = AppSession;
