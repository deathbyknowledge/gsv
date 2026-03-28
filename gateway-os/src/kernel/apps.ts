import type {
  AppBackendBinding,
  AppBackendInstanceScope,
  AppHostKind,
  AppSession,
  AppSessionHost,
} from "../app-runtime/contracts";
import { normalizePath, workspaceRootPath } from "../fs";
import type { SysAppOpenArgs, SysAppOpenHostTarget, SysAppOpenResult } from "../syscalls/app";
import type { ProcWorkspaceKind } from "../syscalls/proc";
import { executeDynamicWorkerAppCommand } from "./app-backends";
import type { KernelContext } from "./context";
import type { ProcessRecord } from "./processes";
import type { WorkspaceRecord } from "./workspaces";

export type AppThreadRequirement = "none" | "optional" | "required";
export type AppWorkspaceMode = "none" | "inherit-thread" | "inherit-context" | "new-app";

type AppKernelBindingSpec = {
  kind: "kernel";
  syscalls: readonly string[];
};

type AppThreadBindingSpec = {
  kind: "thread";
  required?: boolean;
};

type AppWorkspaceBindingSpec = {
  kind: "workspace";
  access: "read" | "read-write";
  required?: boolean;
};

type AppServiceBindingSpec = {
  kind: "service";
  binding: string;
  capability: string;
  required?: boolean;
};

type AppBackendBindingSpec =
  | AppKernelBindingSpec
  | AppThreadBindingSpec
  | AppWorkspaceBindingSpec
  | AppServiceBindingSpec;

type AppNoneBackendSpec = {
  kind: "none";
};

type AppDynamicWorkerBackendSpec = {
  kind: "dynamic-worker";
  workerName: string;
  entrypoint?: string;
  lifecycle: AppBackendInstanceScope;
  network: "none" | "gateway";
  bindings: readonly AppBackendBindingSpec[];
};

type AppBackendSpec = AppNoneBackendSpec | AppDynamicWorkerBackendSpec;

export type AppCommandSpec = {
  name: string;
  binaryName: string;
  description: string;
  usage?: string;
};

export type AppRendererSpec = {
  name: string;
  hosts: ReadonlyArray<Extract<AppHostKind, "window" | "webview">>;
};

export type AppPackageManifest = {
  appId: string;
  name: string;
  description: string;
  thread: AppThreadRequirement;
  workspace: {
    mode: AppWorkspaceMode;
    kind?: ProcWorkspaceKind;
    label?: string;
  };
  backend: AppBackendSpec;
  commands?: readonly AppCommandSpec[];
  renderers?: readonly AppRendererSpec[];
};

export type AppRuntimeSpec = AppPackageManifest;

export type AppShellCommandBinding = {
  appId: string;
  packageName: string;
  command: AppCommandSpec;
};

type DynamicWorkerEnv = Env & {
  APP_BACKENDS?: WorkerLoader;
};

export const APP_PACKAGE_REGISTRY: Record<string, AppPackageManifest> = {
  chat: {
    appId: "chat",
    name: "Chat",
    description: "Conversational workspace with agents.",
    thread: "optional",
    workspace: { mode: "inherit-thread" },
    backend: { kind: "none" },
    renderers: [{ name: "desktop", hosts: ["window"] }],
  },
  shell: {
    appId: "shell",
    name: "Shell",
    description: "Interactive command shell for nodes.",
    thread: "optional",
    workspace: { mode: "inherit-thread" },
    backend: { kind: "none" },
    renderers: [{ name: "desktop", hosts: ["window"] }],
  },
  devices: {
    appId: "devices",
    name: "Devices",
    description: "Connected machine inventory and runtime device status.",
    thread: "none",
    workspace: { mode: "none" },
    backend: { kind: "none" },
    renderers: [{ name: "desktop", hosts: ["window"] }],
  },
  processes: {
    appId: "processes",
    name: "Processes",
    description: "Inspect and manage running agent processes.",
    thread: "none",
    workspace: { mode: "none" },
    backend: { kind: "none" },
    renderers: [{ name: "desktop", hosts: ["window"] }],
  },
  files: {
    appId: "files",
    name: "Files",
    description: "File browser and workspace management.",
    thread: "optional",
    workspace: { mode: "inherit-thread" },
    backend: { kind: "none" },
    renderers: [{ name: "desktop", hosts: ["window"] }],
  },
  control: {
    appId: "control",
    name: "Control",
    description: "System status, permissions, and settings.",
    thread: "none",
    workspace: { mode: "none" },
    backend: { kind: "none" },
    renderers: [{ name: "desktop", hosts: ["window"] }],
  },
  "workspace-doctor": {
    appId: "workspace-doctor",
    name: "Workspace Doctor",
    description: "Formula-like diagnostic package for workspace repair and explanation.",
    thread: "none",
    workspace: { mode: "inherit-context" },
    backend: {
      kind: "dynamic-worker",
      workerName: "workspace-doctor-backend",
      entrypoint: "WorkspaceDoctor",
      lifecycle: "workspace",
      network: "none",
      bindings: [
        { kind: "kernel", syscalls: ["fs.read", "fs.search", "shell.exec"] },
        { kind: "workspace", access: "read-write" },
      ],
    },
    commands: [
      {
        name: "doctor",
        binaryName: "doctor",
        description: "Scan, explain, and repair workspace issues.",
        usage: "doctor [scan|fix|explain] [path]",
      },
    ],
  },
  "ops-console": {
    appId: "ops-console",
    name: "Ops Console",
    description: "Cask-like operational console for devices, processes, and runtime state.",
    thread: "none",
    workspace: { mode: "none" },
    backend: {
      kind: "dynamic-worker",
      workerName: "ops-console-backend",
      entrypoint: "OpsConsole",
      lifecycle: "shared",
      network: "gateway",
      bindings: [
        { kind: "kernel", syscalls: ["sys.device.list", "sys.device.get", "proc.list"] },
      ],
    },
    renderers: [
      { name: "console", hosts: ["window", "webview"] },
    ],
  },
  deploy: {
    appId: "deploy",
    name: "Deploy",
    description: "Hybrid package with both shell commands and a richer deployment UI.",
    thread: "none",
    workspace: { mode: "inherit-context" },
    backend: {
      kind: "dynamic-worker",
      workerName: "deploy-backend",
      entrypoint: "DeployControlPlane",
      lifecycle: "workspace",
      network: "gateway",
      bindings: [
        { kind: "kernel", syscalls: ["proc.spawn", "proc.send", "shell.exec"] },
        { kind: "workspace", access: "read-write" },
        { kind: "service", binding: "RIPGIT", capability: "ripgit.internal" },
      ],
    },
    commands: [
      {
        name: "deploy",
        binaryName: "deploy",
        description: "Launch deployments, inspect status, and stream logs.",
        usage: "deploy <up|status|logs|rollback> [args]",
      },
    ],
    renderers: [
      { name: "control-tower", hosts: ["window", "webview"] },
    ],
  },
};

export function getAppPackage(appId: string): AppPackageManifest | undefined {
  return APP_PACKAGE_REGISTRY[appId];
}

export function getAppRuntimeSpec(appId: string): AppRuntimeSpec | undefined {
  return getAppPackage(appId);
}

export function listShellAppCommands(
  registry: Record<string, AppPackageManifest> = APP_PACKAGE_REGISTRY,
): AppShellCommandBinding[] {
  return Object.values(registry)
    .flatMap((pkg) => (pkg.commands ?? []).map((command) => ({
      appId: pkg.appId,
      packageName: pkg.name,
      command,
    })))
    .sort((left, right) => left.command.binaryName.localeCompare(right.command.binaryName));
}

export function openAppSession(
  args: SysAppOpenArgs,
  ctx: KernelContext,
  registry: Record<string, AppPackageManifest> = APP_PACKAGE_REGISTRY,
): SysAppOpenResult {
  const appId = normalizeToken(args.appId, "appId");
  const spec = registry[appId];

  if (!spec) {
    throw new Error(`Unknown app package: ${appId}`);
  }

  const host = normalizeHost(args.host);
  const surface = resolveSurface(spec, host.kind, args.surface);
  const thread = resolveThreadSession(args, spec, ctx);
  const workspace = resolveWorkspaceSession(args, spec, thread, ctx);

  const session: AppSession = {
    sessionId: crypto.randomUUID(),
    appId,
    host,
    surface,
    ownerUid: ctx.identity?.process.uid ?? null,
    thread,
    workspace,
    backend: {
      kind: "none",
      state: "not-required",
      bindings: [],
    },
  };

  session.backend = resolveBackendSession(spec, session, ctx.env);
  return { session };
}

export async function executeShellAppCommand(
  binaryName: string,
  args: string[],
  ctx: KernelContext,
  options?: {
    cwd?: string;
  },
  registry: Record<string, AppPackageManifest> = APP_PACKAGE_REGISTRY,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const binding = findShellCommand(binaryName, registry);
  if (!binding) {
    return {
      stdout: "",
      stderr: `${binaryName}: command not found\n`,
      exitCode: 127,
    };
  }

  const session = openAppSession(
    {
      appId: binding.appId,
      host: {
        kind: "shell",
        instanceId: binaryName,
      },
      surface: {
        kind: "command",
        name: binding.command.name,
      },
      target: {
        host: normalizeHostTargetFromShell(options?.cwd),
      },
    },
    ctx,
    registry,
  ).session;

  if (args.includes("--help") || args.includes("-h")) {
    return {
      stdout: formatShellCommandHelp(binding, session),
      stderr: "",
      exitCode: 0,
    };
  }

  if (session.backend.kind === "none") {
    return {
      stdout: "",
      stderr: `${binaryName}: app package has no backend runtime\n`,
      exitCode: 1,
    };
  }

  if (session.backend.state === "missing_loader") {
    return {
      stdout: "",
      stderr: `${binaryName}: app backend loader APP_BACKENDS is not configured\n`,
      exitCode: 1,
    };
  }

  return executeDynamicWorkerAppCommand(
    session,
    {
      name: binding.command.name,
      binaryName: binding.command.binaryName,
      argv: args,
    },
    ctx,
  );
}

function normalizeToken(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} is required`);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }

  return normalized;
}

function normalizeHost(value: SysAppOpenArgs["host"]): AppSessionHost {
  if (!value) {
    throw new Error("host is required");
  }

  const kind = normalizeHostKind(value.kind);
  const instanceId = normalizeToken(value.instanceId, "host.instanceId");
  return { kind, instanceId };
}

function normalizeHostKind(value: unknown): AppHostKind {
  if (
    value === "window" ||
    value === "shell" ||
    value === "agent" ||
    value === "webview"
  ) {
    return value;
  }

  throw new Error("host.kind is invalid");
}

function resolveSurface(
  spec: AppPackageManifest,
  hostKind: AppHostKind,
  requested: SysAppOpenArgs["surface"],
): AppSession["surface"] {
  if (requested) {
    const name = normalizeToken(requested.name, "surface.name");

    if (requested.kind === "command") {
      const command = (spec.commands ?? []).find((item) => item.name === name || item.binaryName === name);
      if (!command) {
        throw new Error(`App "${spec.appId}" has no command surface "${name}"`);
      }
      return { kind: "command", name: command.name };
    }

    if (requested.kind === "renderer") {
      const renderer = (spec.renderers ?? []).find((item) => item.name === name);
      if (!renderer || !renderer.hosts.includes(hostKind as Extract<AppHostKind, "window" | "webview">)) {
        throw new Error(`App "${spec.appId}" has no renderer surface "${name}" for host ${hostKind}`);
      }
      return { kind: "renderer", name: renderer.name };
    }

    throw new Error("surface.kind is invalid");
  }

  if (hostKind === "window" || hostKind === "webview") {
    const renderer = (spec.renderers ?? []).find((item) => item.hosts.includes(hostKind));
    if (renderer) {
      return { kind: "renderer", name: renderer.name };
    }
  }

  if (hostKind === "shell" || hostKind === "agent") {
    const command = spec.commands?.[0];
    if (command) {
      return { kind: "command", name: command.name };
    }
  }

  throw new Error(`App "${spec.appId}" has no compatible surface for host ${hostKind}`);
}

function resolveThreadSession(
  args: SysAppOpenArgs,
  spec: AppPackageManifest,
  ctx: KernelContext,
): AppSession["thread"] {
  if (spec.thread === "none") {
    return null;
  }

  const pid = typeof args.target?.thread?.pid === "string" ? args.target.thread.pid.trim() : "";
  if (!pid) {
    if (spec.thread === "required") {
      throw new Error(`App "${spec.appId}" requires a thread target`);
    }
    return null;
  }

  const process = ctx.procs.get(pid);
  if (!process) {
    throw new Error(`Process not found: ${pid}`);
  }

  const callerUid = ctx.identity!.process.uid;
  if (callerUid !== 0 && process.uid !== callerUid) {
    throw new Error(`Permission denied: cannot bind app to foreign process ${pid}`);
  }

  return {
    pid: process.processId,
    cwd: process.cwd,
    workspaceId: process.workspaceId,
  };
}

function resolveWorkspaceSession(
  args: SysAppOpenArgs,
  spec: AppPackageManifest,
  thread: AppSession["thread"],
  ctx: KernelContext,
): AppSession["workspace"] {
  const hostTarget = normalizeHostTarget(args.target?.host ?? null);

  switch (spec.workspace.mode) {
    case "none":
      return null;
    case "inherit-thread": {
      if (!thread?.workspaceId) {
        return null;
      }

      const workspace = ctx.workspaces.get(thread.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${thread.workspaceId}`);
      }

      ctx.workspaces.touch(workspace.workspaceId);
      return toWorkspaceSession(workspace, thread.cwd);
    }
    case "inherit-context": {
      if (hostTarget) {
        return resolveWorkspaceSessionFromHostTarget(hostTarget, ctx);
      }

      const process = ctx.identity!.process;
      if (!process.workspaceId) {
        return null;
      }

      const workspace = ctx.workspaces.get(process.workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${process.workspaceId}`);
      }

      ctx.workspaces.touch(workspace.workspaceId);
      return toWorkspaceSession(workspace, process.cwd);
    }
    case "new-app": {
      const ownerUid = ctx.identity!.process.uid;
      const workspace = ctx.workspaces.create(ownerUid, {
        label: spec.workspace.label ?? spec.appId,
        kind: spec.workspace.kind ?? "app",
        metaJson: JSON.stringify({
          appId: spec.appId,
          createdBy: "sys.app.open",
        }),
      });

      return toWorkspaceSession(workspace, workspaceRootPath(workspace.workspaceId));
    }
    default:
      return null;
  }
}

function normalizeHostTargetFromShell(cwd: string | undefined): SysAppOpenHostTarget | null {
  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    return null;
  }

  const normalizedCwd = normalizePath(cwd.trim());
  return {
    cwd: normalizedCwd,
    workspaceId: inferWorkspaceIdFromPath(normalizedCwd),
  };
}

function normalizeHostTarget(
  value: SysAppOpenHostTarget | null,
): { cwd: string; workspaceId: string | null } | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const cwd = typeof value.cwd === "string" && value.cwd.trim().length > 0
    ? normalizePath(value.cwd.trim())
    : "";
  const workspaceId = typeof value.workspaceId === "string" && value.workspaceId.trim().length > 0
    ? value.workspaceId.trim()
    : inferWorkspaceIdFromPath(cwd);

  if (!cwd && !workspaceId) {
    return null;
  }

  return {
    cwd: cwd || workspaceRootPath(workspaceId!),
    workspaceId: workspaceId ?? null,
  };
}

function resolveWorkspaceSessionFromHostTarget(
  target: { cwd: string; workspaceId: string | null },
  ctx: KernelContext,
): AppSession["workspace"] {
  if (!target.workspaceId) {
    return null;
  }

  const workspace = ctx.workspaces.get(target.workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${target.workspaceId}`);
  }

  ctx.workspaces.touch(workspace.workspaceId);
  return toWorkspaceSession(workspace, target.cwd);
}

function inferWorkspaceIdFromPath(path: string): string | null {
  const normalized = normalizePath(path);
  const match = /^\/workspaces\/([^/]+)(?:\/|$)/.exec(normalized);
  return match?.[1] ?? null;
}

function toWorkspaceSession(workspace: WorkspaceRecord, cwd: string): AppSession["workspace"] {
  return {
    workspaceId: workspace.workspaceId,
    root: workspaceRootPath(workspace.workspaceId),
    cwd,
    kind: workspace.kind,
    ownerUid: workspace.ownerUid,
  };
}

function resolveBackendSession(
  spec: AppPackageManifest,
  session: AppSession,
  env: Env,
): AppSession["backend"] {
  if (spec.backend.kind === "none") {
    return {
      kind: "none",
      state: "not-required",
      bindings: [],
    };
  }

  if (spec.backend.lifecycle === "workspace" && !session.workspace) {
    throw new Error(`App "${spec.appId}" backend lifecycle requires a workspace`);
  }

  return {
    kind: "dynamic-worker",
    state: getDynamicWorkerLoader(env) ? "ready" : "missing_loader",
    loaderBinding: "APP_BACKENDS",
    loaderMethod: "get",
    workerName: spec.backend.workerName,
    entrypoint: spec.backend.entrypoint ?? "default",
    lifecycle: spec.backend.lifecycle,
    instanceKey: computeBackendInstanceKey(spec.appId, session, spec.backend.lifecycle),
    network: spec.backend.network,
    bindings: resolveBackendBindings(spec, session, env),
  };
}

function resolveBackendBindings(
  spec: AppPackageManifest,
  session: AppSession,
  env: Env,
): AppBackendBinding[] {
  if (spec.backend.kind === "none") {
    return [];
  }

  const bindings: AppBackendBinding[] = [];

  for (const binding of spec.backend.bindings) {
    switch (binding.kind) {
      case "kernel":
        bindings.push({
          kind: "kernel",
          syscalls: Array.from(new Set(binding.syscalls)),
        });
        break;
      case "thread":
        if (!session.thread) {
          if (binding.required !== false) {
            throw new Error(`App "${spec.appId}" backend requires a thread binding`);
          }
          break;
        }

        bindings.push({
          kind: "thread",
          thread: session.thread,
        });
        break;
      case "workspace":
        if (!session.workspace) {
          if (binding.required !== false) {
            throw new Error(`App "${spec.appId}" backend requires a workspace binding`);
          }
          break;
        }

        bindings.push({
          kind: "workspace",
          access: binding.access,
          workspace: session.workspace,
        });
        break;
      case "service": {
        const configured = hasBinding(env, binding.binding);
        if (!configured && binding.required !== false) {
          throw new Error(`App "${spec.appId}" backend requires binding "${binding.binding}"`);
        }

        bindings.push({
          kind: "service",
          binding: binding.binding,
          capability: binding.capability,
          status: configured ? "configured" : "missing",
        });
        break;
      }
      default:
        break;
    }
  }

  return bindings;
}

function computeBackendInstanceKey(
  appId: string,
  session: AppSession,
  lifecycle: AppBackendInstanceScope,
): string {
  switch (lifecycle) {
    case "shared":
      return `app:${appId}:shared`;
    case "workspace":
      return `app:${appId}:workspace:${session.workspace!.workspaceId}`;
    case "host":
    default:
      return `app:${appId}:host:${session.host.kind}:${session.host.instanceId}`;
  }
}

function hasBinding(env: Env, binding: string): boolean {
  const bindings = env as unknown as Record<string, unknown>;
  return typeof bindings[binding] !== "undefined";
}

function getDynamicWorkerLoader(env: Env): WorkerLoader | null {
  const loader = (env as DynamicWorkerEnv).APP_BACKENDS;
  return loader ?? null;
}

function findShellCommand(
  binaryName: string,
  registry: Record<string, AppPackageManifest>,
): AppShellCommandBinding | null {
  return listShellAppCommands(registry).find((item) => item.command.binaryName === binaryName) ?? null;
}

function formatShellCommandHelp(binding: AppShellCommandBinding, session: AppSession): string {
  const usage = binding.command.usage ? `usage: ${binding.command.usage}` : null;
  const workspace = session.workspace?.workspaceId ?? "none";
  const backend = session.backend.kind === "dynamic-worker"
    ? `${session.backend.kind}:${session.backend.state}`
    : session.backend.kind;

  return [
    `${binding.command.binaryName} - ${binding.command.description}`,
    usage,
    `package: ${binding.appId} (${binding.packageName})`,
    `surface: ${session.surface.kind}:${session.surface.name}`,
    `host: ${session.host.kind}:${session.host.instanceId}`,
    `workspace: ${workspace}`,
    `backend: ${backend}`,
  ].filter((line): line is string => Boolean(line)).join("\n") + "\n";
}

export function processRecordToThreadSession(process: ProcessRecord): AppSession["thread"] {
  return {
    pid: process.processId,
    cwd: process.cwd,
    workspaceId: process.workspaceId,
  };
}
