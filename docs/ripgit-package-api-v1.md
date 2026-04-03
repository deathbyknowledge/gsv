# ripgit package api v1

This document defines the v1 ripgit package analysis/build API.

It sits between:

- ripgit core source control primitives
- package SDK static analysis
- package artifact building
- kernel/package install flows

The main goal is to keep package handling coherent without collapsing the generic ripgit workspace story into a package-only system.

## design goals

- Keep ripgit useful as the general version-controlled workspace substrate.
- Add a first-class package workflow on top of that substrate.
- Make package source resolution deterministic.
- Make package analysis and build outputs cacheable.
- Keep package loading and package builds declarative.

## non-goals

- Replacing generic ripgit repo/tree/branch operations with package-only abstractions.
- Supporting arbitrary language ecosystems.
- Supporting arbitrary package-defined build hooks in the kernel install path.

## layer split

The model is:

- `ripgit core`
  - generic source control primitives
- `ripgit packages`
  - package detection
  - package analysis
  - package build
  - package resolution

This is one system with two layers, not two unrelated systems.

## source locator model

Packages are always addressed by:

```ts
type PackageSourceLocator = {
  repo: string;
  ref: string;
  subdir: string;
};
```

Resolution always produces:

```ts
type ResolvedPackageSource = {
  repo: string;
  ref: string;
  resolvedCommit: string;
  subdir: string;
};
```

Important rule:

- `ref` is user-facing and convenient
- `resolvedCommit` is runtime-facing and deterministic

Both must be preserved.

## ripgit core api

This remains generic and package-agnostic.

```ts
type RipgitTreeEntry = {
  path: string;
  kind: "file" | "dir";
};

interface RipgitCore {
  resolveRef(repo: string, ref: string): Promise<string>;
  readFile(source: ResolvedPackageSource, path: string): Promise<string>;
  readTree(source: ResolvedPackageSource): Promise<RipgitTreeEntry[]>;
  diff(repo: string, baseRef: string, headRef: string, subdir?: string): Promise<unknown>;
  createBranch(repo: string, fromRef: string, branch: string): Promise<void>;
  writeFiles(repo: string, branch: string, files: Array<{ path: string; content: string }>): Promise<void>;
  commit(repo: string, branch: string, message: string): Promise<string>;
}
```

This layer should stay usable for any version-controlled workspace flow, not only packages.

## package-aware api

`ripgit packages` builds on `ripgit core`.

```ts
interface RipgitPackages {
  listPackages(repo: string, ref: string, options?: { root?: string }): Promise<PackageListing[]>;
  analyzePackage(source: PackageSourceLocator): Promise<PackageAnalysis>;
  buildPackage(source: PackageSourceLocator, options?: BuildPackageOptions): Promise<PackageBuild>;
  resolvePackage(source: PackageSourceLocator, options?: BuildPackageOptions): Promise<ResolvedPackage>;
}
```

## package listing

Listing is a package discovery helper.

```ts
type PackageListing = {
  subdir: string;
  packageJsonName: string | null;
  displayName: string | null;
};
```

v1 package detection rule:

- a package exists if the directory contains:
  - `package.json`
  - `src/package.ts`

This is intentionally simple.

## diagnostics model

All package-aware APIs return structured diagnostics.

```ts
type PackageDiagnostic = {
  severity: "error" | "warning";
  code: string;
  message: string;
  path: string;
  line: number;
  column: number;
};
```

Rules:

- errors block build success
- warnings do not block build success

## package analysis output

Analysis is the first package-specific stage.

It resolves the source ref and statically understands the package shape without executing package code.

```ts
type PackageIdentity = {
  packageJsonName: string;
  version: string | null;
  displayName: string;
};

type ExtractedHandlerReference = {
  kind: "inline-function" | "local-identifier";
  exportName: "default";
  path: "src/package.ts";
  localName: string | null;
};

type ExtractedPackageDefinition = {
  meta: {
    displayName: string;
    description: string | null;
    icon: string | null;
    window: {
      width: number | null;
      height: number | null;
      minWidth: number | null;
      minHeight: number | null;
    } | null;
    capabilities: {
      kernel: string[];
      outbound: string[];
    };
  };
  setup: ExtractedHandlerReference | null;
  commands: Array<{
    name: string;
    handler: ExtractedHandlerReference;
  }>;
  app: {
    handler: ExtractedHandlerReference;
  } | null;
  tasks: Array<{
    name: string;
    handler: ExtractedHandlerReference;
  }>;
};

type AnalyzedPackageJson = {
  name: string;
  version: string | null;
  type: string | null;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

type PackageAnalysis = {
  source: ResolvedPackageSource;
  packageRoot: string;
  identity: PackageIdentity;
  packageJson: AnalyzedPackageJson;
  definition: ExtractedPackageDefinition;
  diagnostics: PackageDiagnostic[];
  ok: boolean;
  analysisHash: string;
};
```

### analysis responsibilities

`analyzePackage(...)` must:

1. resolve `ref -> resolvedCommit`
2. load `package.json`
3. parse `src/package.ts`
4. run static extraction on `definePackage(...)`
5. validate package shape
6. optionally run package diagnostics such as capability mismatch warnings
7. return normalized analysis output

### analysis constraints

`analyzePackage(...)` must not:

- execute package code
- execute arbitrary build hooks
- depend on runtime package install state

## package build output

Build consumes package source and emits a normalized runtime artifact.

```ts
type PackageArtifactModule = {
  path: string;
  kind: "esmodule" | "text" | "json";
  content: string;
};

type PackageArtifact = {
  hash: string;
  mainModule: string;
  modules: PackageArtifactModule[];
  compatibilityDate: string;
  compatibilityFlags: string[];
};

type BuildPackageOptions = {
  target?: "dynamic-worker";
};

type PackageBuild = {
  source: ResolvedPackageSource;
  analysisHash: string;
  target: "dynamic-worker";
  artifact: PackageArtifact | null;
  diagnostics: PackageDiagnostic[];
  ok: boolean;
};
```

### build responsibilities

`buildPackage(...)` must:

1. run analysis or reuse cached analysis
2. resolve npm dependencies from `package.json`
3. compile TS/JS/JSX/TSX inputs
4. apply package SDK lowering/transforms if needed
5. bundle worker/browser modules
6. copy or embed static assets as needed
7. emit a normalized `PackageArtifact`
8. compute a content-derived `artifact.hash`

### build constraints

`buildPackage(...)` must not:

- run arbitrary lifecycle scripts from the package
- depend on side effects outside the declared package source and dependency graph
- produce non-deterministic output for the same resolved source + build config

## resolved package output

`resolvePackage(...)` is the package-manager/kernel-friendly operation.

```ts
type ResolvedPackage = {
  source: ResolvedPackageSource;
  analysis: PackageAnalysis;
  build: PackageBuild;
};
```

This is the operation most install/checkout flows should use.

## cache model

The package layer should be aggressively cacheable.

### analysis cache key

Suggested conceptual key:

- `resolvedCommit`
- `subdir`
- extractor/analyzer version

### build cache key

Suggested conceptual key:

- `resolvedCommit`
- `subdir`
- analyzer version
- build target
- bundler/transform version
- package sdk version

Important note:

- cache keys are implementation details
- but they must be deterministic and versioned by toolchain behavior

## package detection rules

v1 detection is deliberately narrow.

A directory is a package when all of these are present:

- `package.json`
- `src/package.ts`

This allows ripgit to discover packages inside a monorepo without custom conventions beyond the package contract.

## npm dependency model

Packages use standard npm dependencies declared in `package.json`.

The package API assumes:

- third-party dependencies are normal and supported
- build tooling resolves and bundles them before runtime loading
- runtime loading receives already-built artifacts

This matches Cloudflare’s Dynamic Workers model, where TypeScript and npm dependencies must be bundled ahead of time.

Reference:

- https://developers.cloudflare.com/dynamic-workers/getting-started/

## oxc and oxlint placement

OXC and Oxlint belong inside the package-aware layer, not inside ripgit core.

### OXC is a fit for

- parsing `src/package.ts`
- static extraction of `definePackage(...)`
- validating package shape
- transforms/lowering for package SDK code
- JS/TS/JSX/TSX compilation support

### Oxlint is a fit for

- live package diagnostics
- lint feedback in editors/dev tools
- warnings returned during analysis

Important boundary:

- source control remains a ripgit core concern
- parsing/analysis/build remains a ripgit package concern

## kernel integration shape

The kernel/package manager should conceptually use:

1. `resolvePackage({ repo, ref, subdir })`
2. validate grants/policy against `analysis.definition.meta.capabilities`
3. store:
   - `repo`
   - `ref`
   - `resolvedCommit`
   - `subdir`
   - `artifact.hash`
4. load or reuse the Dynamic Worker by `artifact.hash`

This preserves:

- stable source identity
- deterministic build identity
- stable Package DO identity across code changes

## examples

### analyze package

```ts
const analysis = await ripgitPackages.analyzePackage({
  repo: "system/gsv",
  ref: "main",
  subdir: "gateway-os/packages/files",
});
```

### build package

```ts
const build = await ripgitPackages.buildPackage({
  repo: "system/gsv",
  ref: "main",
  subdir: "gateway-os/packages/files",
});
```

### resolve package

```ts
const resolved = await ripgitPackages.resolvePackage({
  repo: "system/gsv",
  ref: "feature/local-files-ui",
  subdir: "gateway-os/packages/files",
});
```

## immediate implementation order

1. Implement `analyzePackage(...)` using the static extraction contract.
2. Implement `resolveRef(...)` integration so `resolvedCommit` is always present.
3. Implement `buildPackage(...)` for the `dynamic-worker` target.
4. Switch kernel package resolution to consume `resolvePackage(...)`.

## open questions

These are still intentionally open:

1. Should package listing support ignored directories/config later?
2. Should build and analysis be separate persistent caches or a single layered cache?
3. How much linting should be returned inline from `analyzePackage(...)` vs a separate `lintPackage(...)` API?
4. When do we expose watch-mode/incremental APIs for editor/dev use?
