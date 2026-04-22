export type PackageAssemblyTarget = "dynamic-worker";

export type PackageAssemblyDiagnostic = {
  severity: "error" | "warning";
  code: string;
  message: string;
  path: string;
  line: number;
  column: number;
};

export type PackageAssemblySource = {
  repo: string;
  ref: string;
  resolved_commit: string;
  subdir: string;
};

export type PackageAssemblyAnalysis = {
  source: PackageAssemblySource;
  package_root: string;
  identity: {
    package_json_name: string;
    version?: string | null;
    display_name: string;
  };
  package_json: {
    name: string;
    version?: string | null;
    type?: string | null;
    dependencies: Record<string, string>;
    dev_dependencies: Record<string, string>;
  };
  definition?: {
    meta: {
      display_name: string;
      description?: string | null;
      icon?: string | null;
      window?: {
        width?: number | null;
        height?: number | null;
        min_width?: number | null;
        min_height?: number | null;
      } | null;
      capabilities: {
        kernel: string[];
        outbound: string[];
      };
    };
    commands: Array<{
      name: string;
      entry?: string | null;
    }>;
    browser?: {
      entry: string;
      assets: string[];
    } | null;
    backend?: {
      entry: string;
      public_routes: string[];
    } | null;
    app?: {
      handler: {
        export_name: string;
      };
      has_rpc: boolean;
      rpc_methods: string[];
      browser_entry?: string | null;
      assets: string[];
    } | null;
  } | null;
  diagnostics: PackageAssemblyDiagnostic[];
  ok: boolean;
  analysis_hash: string;
};

export type PackageAssemblyArtifactModule = {
  path: string;
  kind: "source-module" | "commonjs" | "json" | "text" | "data";
  content: string;
};

export type PackageAssemblyArtifact = {
  main_module: string;
  modules: PackageAssemblyArtifactModule[];
  hash: string;
};

export type PackageAssemblyRequest = {
  analysis: PackageAssemblyAnalysis;
  target: PackageAssemblyTarget;
  files: Record<string, string>;
};

export type PackageAssemblyResponse = {
  source: PackageAssemblySource;
  analysis_hash: string;
  target: PackageAssemblyTarget;
  artifact?: PackageAssemblyArtifact | null;
  diagnostics: PackageAssemblyDiagnostic[];
  ok: boolean;
};

export interface PackageAssemblerInterface {
  assemblePackage(input: PackageAssemblyRequest): Promise<PackageAssemblyResponse>;
}
