export type PkgRuntime = "dynamic-worker" | "node" | "web-ui";

export type PkgListArgs = {
  enabled?: boolean;
  name?: string;
  runtime?: PkgRuntime;
};

export type PkgEntrypointSummary = {
  name: string;
  kind: "command" | "http" | "rpc" | "task" | "ui";
  description?: string;
  command?: string;
  route?: string;
  tagName?: `${string}-${string}`;
  icon?:
    | { kind: "builtin"; id: string }
    | { kind: "svg"; svg: string };
  syscalls?: string[];
  windowDefaults?: {
    width: number;
    height: number;
    minWidth: number;
    minHeight: number;
  };
};

export type PkgSummary = {
  packageId: string;
  name: string;
  description: string;
  version: string;
  runtime: PkgRuntime;
  enabled: boolean;
  source: {
    kind: "builtin" | "workspace" | "git" | "registry";
    ref: string;
    revision?: string | null;
  };
  entrypoints: PkgEntrypointSummary[];
  bindingNames: string[];
  stateBindings: string[];
  installedAt: number;
  updatedAt: number;
};

export type PkgListResult = {
  packages: PkgSummary[];
};
