import path from "node:path";

export const PUBLIC_PACKAGE_DIRECTORIES = Object.freeze([
  "packages/gsv",
  "packages/portable-archive",
  "packages/worker-runtime",
  "packages/cloudflare-release",
]);

/**
 * Build npm commands that operate from inside one package directory. npm treats
 * a bare value such as `packages/gsv` as a Git shorthand, so local publication
 * commands deliberately have no positional package specifier at all.
 */
export function publicPackageCommandPlan(root, directory, packDestination) {
  const cwd = publicPackageRoot(root, directory);
  const pack = invocation(cwd, [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    path.resolve(packDestination),
  ]);
  const publishDryRun = invocation(cwd, [
    "publish",
    "--dry-run",
    "--access",
    "public",
  ]);
  const publish = invocation(cwd, [
    "publish",
    "--provenance",
    "--access",
    "public",
  ]);
  return Object.freeze({ pack, publishDryRun, publish });
}

function publicPackageRoot(root, directory) {
  if (!PUBLIC_PACKAGE_DIRECTORIES.includes(directory)) {
    throw new Error(`Unknown public package directory: ${directory}`);
  }
  const normalizedRoot = path.resolve(root);
  const packageRoot = path.resolve(normalizedRoot, directory);
  const relative = path.relative(normalizedRoot, packageRoot);
  if (
    relative === ""
    || relative.startsWith(`..${path.sep}`)
    || relative === ".."
    || path.isAbsolute(relative)
  ) {
    throw new Error(`Public package directory escapes the repository: ${directory}`);
  }
  return packageRoot;
}

function invocation(cwd, arguments_) {
  if (arguments_.length < 2 || !arguments_[1].startsWith("--")) {
    throw new Error("Local npm package commands must not contain a positional package specifier");
  }
  return Object.freeze({
    command: "npm",
    arguments: Object.freeze(arguments_),
    cwd,
  });
}
