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

export type PackageBrowserDefinition = {
  entry: string;
  assets?: string[];
};

export type PackageBackendDefinition = {
  entry: string;
  public_routes?: string[];
};

export type PackageCliDefinition = {
  commands?: Record<string, string>;
};

export type PackageDefinition = {
  meta: PackageMeta;
  browser?: PackageBrowserDefinition;
  backend?: PackageBackendDefinition;
  cli?: PackageCliDefinition;
};

export function definePackage<const T extends PackageDefinition>(definition: T): T {
  return definition;
}
