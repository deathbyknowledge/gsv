# package assembly v2

This document defines the proposed v2 package assembly contract for GSV package
apps.

It is intended to replace the current assembler worker's runtime bundling model
with an explicit assembly pipeline built around:

- Dynamic Workers artifacts
- a virtual filesystem
- npm package installation into a virtual `node_modules`
- module graph resolution
- Oxc-based TS / JSX transformation
- structured diagnostics

This is an implementation spec, not a user tutorial.

## goal

The goal of v2 is:

- keep package assembly under the free-tier Worker size limit
- remove the embedded general-purpose bundler runtime from the assembler worker
- make the package build surface explicit and debuggable
- standardize package browser boot around a fixed platform HTML shell
- preserve the current Dynamic Workers artifact model
- make the package runtime entrypoint-based by default instead of relying on
  implicit generated Durable Object facets

## non-goals

v2 is not trying to be:

- a general-purpose Vite / Webpack / Rollup replacement
- a plugin-extensible build system
- a package author escape hatch for arbitrary HTML shells
- a perfect emulation of every npm edge case on day one

The assembler only needs to support the package model GSV actually wants to run.

## key decisions

### dynamic workers remain the target

The assembly target stays:

```ts
type PackageAssemblyTarget = "dynamic-worker";
```

The output artifact shape remains:

- `main_module`
- `modules[]`
- artifact hash

See:

- [shared/protocol/src/package-assembly.ts](/home/hank/theagentscompany/gsv/shared/protocol/src/package-assembly.ts:1)

### `AppRunner` stays the supervisor

The gateway-side `AppRunner` Durable Object remains the package runtime
supervisor.

Its responsibilities include:

- per-package runtime identity
- app session coordination
- signal subscriptions and delivery
- daemon scheduling
- any package-scoped durable state the platform chooses to expose

What changes in v2 is the child runtime contract.

The package worker should be treated as an explicit set of entrypoints:

- HTTP/UI fetch
- backend RPC
- signal handling
- CLI commands

v2 should not require every package artifact to export a hidden `GsvAppFacet`
Durable Object just to satisfy transport plumbing.

### package-owned durable state is explicit

If packages need SQLite-backed state, that should be modeled as an explicit
capability, for example package-scoped storage surfaced by the supervisor.

For the current GSV runtime shape, the simplest default is:

- one logical package database per `AppRunner` identity
- exposed through a package binding such as `storage.sql`

Facets remain a possible future implementation choice for more complex cases,
but they should not be the default contract for every package app.

### package apps use a fixed HTML shell

Package apps no longer provide an HTML document as the primary browser entry.

Instead:

- the platform provides one fixed HTML shell
- the package provides one browser JavaScript / TypeScript entry module
- the shell loads the package browser entry module and provides boot data

This removes HTML parsing and HTML rewriting from assembly.

### `app.browser.entry` stays, but it changes meaning

The package SDK surface can stay conceptually the same:

```ts
app: {
  browser: {
    entry: "./src/main.tsx";
  }
}
```

But in v2:

- `entry` must be a JS / JSX / TS / TSX / MJS / MTS / CJS / CTS module path
- `entry` must not point to an HTML file
- HTML entries are rejected immediately; there is no compatibility warning phase

Rejected in v2:

```ts
browser: {
  entry: "./src/index.html";
}
```

### commonjs is preserved when needed

The assembler does not need to force all modules into ESM.

Dynamic Workers support explicit module kinds, and the GSV artifact model already
represents both:

- `source-module`
- `commonjs`

So v2 should preserve CJS modules as CJS where appropriate instead of treating
CommonJS support as a mandatory transpilation problem.

### npm installation is a first-class assembly stage

Dependency installation is not an implementation detail.

It is a formal stage in the assembly pipeline and must produce diagnostics and a
deterministic virtual filesystem result.

## why this change exists

The current assembler uses `@cloudflare/worker-bundler` inside the worker
itself, which pulls in an embedded `esbuild.wasm`. That makes the assembler
worker too large for the free-tier compressed upload limit.

More importantly, the current design hides several concerns behind the runtime
bundler:

- dependency installation
- resolution
- TS / JSX transforms
- HTML script rewriting
- module kind conversion
- warning normalization

v2 makes these stages explicit.

## package contract v2

### required package definition file

The package definition source remains:

- `src/package.ts`

Static extraction remains the source of truth for package analysis. See:

- [docs/package-sdk-static-extraction.md](/home/hank/theagentscompany/gsv/docs/package-sdk-static-extraction.md:1)

### app browser contract

When `app.browser.entry` is present:

- it must reference a module file, not HTML
- it is the root browser module for the package app
- it is assembled into Dynamic Worker modules
- it is loaded by the fixed platform shell

If the browser entry uses JSX, the package must declare its UI runtime
dependency explicitly.

For the current GSV browser contract:

- Oxc will emit `preact/jsx-runtime` imports for JSX modules
- packages that use JSX must declare `preact` in `package.json`
- the assembler must not inject `preact` as an implicit fallback dependency

### assets

`app.assets` remains supported.

Assets are for:

- stylesheets
- images
- fonts
- static text files
- other package-owned browser assets

`app.assets` is not the primary app entry mechanism.

For v1:

- CSS should come through declared `app.assets`
- CSS `import "./styles.css"` from JS is intentionally out of scope
- the shell/runtime is responsible for attaching declared stylesheet assets

### fixed shell responsibilities

The platform HTML shell is responsible for:

- creating the root DOM container
- loading the assembled package browser entry
- exposing the package boot payload
- loading platform bridge/runtime helpers

The shell is not package-specific.

### package-specific HTML is out of scope

v2 intentionally removes package-authored HTML as a first-class surface.

If package-specific `<head>` or document structure is needed later, that should
be added deliberately as a small, modeled extension. It should not come back as
"arbitrary HTML entry."

## assembly pipeline

The assembler should be implemented as an explicit staged pipeline.

Each stage:

- has a clear input
- has a clear output
- can emit diagnostics
- can fail without collapsing the whole system into an opaque exception

### stage 1: validate analysis input

Input:

- `PackageAssemblyRequest`
- static analysis result
- repo files

Responsibilities:

- verify `analysis.ok`
- verify package definition exists
- verify target is supported
- verify package identity and package root data are present

Diagnostic family:

- `analysis.*`
- `contract.*`

### stage 2: prepare virtual source tree

Responsibilities:

- start from repo files
- inject SDK fallback packages if the repo does not provide them
- materialize workspace-local packages into the virtual `node_modules`
- optionally normalize package manifests for assembly

This is the stage that replaces the current pre-bundler shaping logic in:

- [assembler/src/index.ts](/home/hank/theagentscompany/gsv/assembler/src/index.ts:230)
- [assembler/src/index.ts](/home/hank/theagentscompany/gsv/assembler/src/index.ts:377)
- [assembler/src/index.ts](/home/hank/theagentscompany/gsv/assembler/src/index.ts:466)

Diagnostic family:

- `prepare.*`

### stage 3: plan and install npm dependencies

Responsibilities:

- read package dependency specs
- prefer lockfile-pinned versions where supported
- fetch tarballs from the npm registry
- extract supported package files into the virtual `node_modules`
- record installed package versions and provenance

This is the most important non-negotiable subsystem in v2.

Diagnostic family:

- `install.registry-unreachable`
- `install.package-not-found`
- `install.version-unsatisfied`
- `install.version-conflict`
- `install.tarball-invalid`
- `install.unsupported-package`
- `install.lockfile-invalid`

### stage 4: resolve module graph

Responsibilities:

- start from the package runtime entrypoints
- resolve relative imports
- resolve package imports
- resolve `exports` / `imports`
- resolve TypeScript extensions and directory indexes
- classify builtins / externals / unsupported imports

The intended engine here is `oxc_resolver` over a custom virtual filesystem.

Diagnostic family:

- `resolve.not-found`
- `resolve.package-entry-invalid`
- `resolve.exports-invalid`
- `resolve.external-unsupported`
- `resolve.tsconfig-invalid`

### stage 5: transform source modules

Responsibilities:

- parse JS / TS / JSX / TSX
- apply TypeScript stripping and JSX transform
- honor modeled compiler settings needed by package authoring
- preserve module structure
- emit transformed source modules

The intended engine here is Oxc.

This stage replaces the current JSX transform shim in:

- [assembler/src/index.ts](/home/hank/theagentscompany/gsv/assembler/src/index.ts:491)

Diagnostic family:

- `transform.parse-error`
- `transform.semantic-error`
- `transform.unsupported-syntax`
- `transform.config-invalid`

### stage 6: classify and emit module kinds

Responsibilities:

- emit ESM as `source-module`
- emit CommonJS as `commonjs`
- emit JSON as `json`
- emit text assets as `text`
- emit binary payloads as `data` if needed

This stage should preserve module boundaries instead of bundling everything into
one synthetic server bundle.

Diagnostic family:

- `emit.unsupported-module-kind`
- `emit.invalid-commonjs`
- `emit.invalid-json`

### stage 7: build package runtime wrapper

Responsibilities:

- generate the Dynamic Worker runtime wrapper
- wire package HTTP/UI fetch entrypoints
- wire package backend RPC entrypoints
- wire package signal entrypoints
- wire package command entrypoints
- attach asset lookup tables
- expose the browser entry path to the fixed shell/runtime

This keeps the current package product surface while making the runtime
contract explicit and removing the bundler from the middle.

Diagnostic family:

- `runtime-wrapper.invalid-definition`
- `runtime-wrapper.missing-handler`

### stage 8: attach static assets

Responsibilities:

- validate declared `app.assets`
- include them as artifact modules or asset payloads
- preserve deterministic paths and content types

In v2, asset handling no longer includes parsing package-authored HTML for
module script tags.

Diagnostic family:

- `asset.missing`
- `asset.unsupported-type`
- `asset.path-invalid`

### stage 9: finalize artifact

Responsibilities:

- sort modules deterministically
- compute artifact hash
- return `PackageAssemblyResponse`

Diagnostic family:

- `artifact.hash-failed`
- `artifact.invalid-module-set`

## diagnostics design

Diagnostics are a first-class output of the pipeline.

Every emitted diagnostic should have:

- `severity`
- `code`
- `message`
- `path`
- `line`
- `column`

See:

- [shared/protocol/src/package-assembly.ts](/home/hank/theagentscompany/gsv/shared/protocol/src/package-assembly.ts:3)

### diagnostic principles

- codes must be stable
- messages must be author-readable
- paths must be package-relative where possible
- infrastructure failures should not be mislabeled as syntax failures
- "unknown error" should be a last resort

### recommended code families

- `analysis.*`
- `contract.*`
- `prepare.*`
- `install.*`
- `resolve.*`
- `transform.*`
- `emit.*`
- `asset.*`
- `runtime-wrapper.*`
- `artifact.*`
- `internal.*`

### examples

Good:

- `install.package-not-found`
- `resolve.not-found`
- `transform.parse-error`
- `asset.missing`

Bad:

- `build-failed`
- `unexpected-error`

The point is to let callers and package authors understand which stage failed.

## npm installer scope for v1

v1 should be deliberately narrow.

### supported in v1

- registry packages from npm
- `package.json` `dependencies`
- package-lock guided version pinning
- `workspace:` / `file:` / `link:` dependencies materialized locally before npm install
- normal JS / TS / JSON / text package contents
- package `exports`
- package `imports`
- `type: module` and CommonJS package distinctions

### explicitly unsupported in v1

- `devDependencies` as runtime assembly inputs
- lifecycle scripts
- native extensions
- postinstall-generated artifacts
- arbitrary binary toolchains
- Yarn PnP
- pnpm store layout semantics
- lockfile parity across every ecosystem

Unsupported cases should produce clear installer diagnostics, not silent
partial behavior.

### workspace handling

Workspace-local packages should remain materialized into virtual
`node_modules/<name>` for resolution.

That behavior exists today and should be preserved because it matches the way
package authors expect workspace-local imports to behave.

The same rule applies to local GSV SDK packages such as:

- `@gsv/package`
- `@gsv/app-link`

If the repo provides them, they should be treated as local packages. If it does
not, the assembler should inject fallback copies before resolution and install
planning.

## commonjs handling

### v1 rule

If a resolved module is CommonJS:

- preserve it as `commonjs` in the artifact when possible
- do not force an ahead-of-time CJS-to-ESM transform unless needed

### why

This keeps v2 aligned with Dynamic Workers capabilities and avoids taking on a
large compatibility surface unnecessarily.

### what still needs care

Even with CJS preservation, the assembler still needs to resolve:

- whether an entrypoint is ESM or CJS
- whether a package export target points at `.cjs`, `.js`, or mixed mode files
- how relative specifiers inside emitted modules are represented

This is real work, but it is much narrower than "implement a full CommonJS
compiler."

## fixed HTML shell

### shell contract

The platform shell should:

- create a root mount node
- expose package boot metadata
- load the package browser entry module
- hand off to the package runtime bridge

### package author contract

Package authors write:

- JS / TS / TSX entry modules
- declared static assets
- CSS referenced through `app.assets`

They do not write top-level application HTML documents.

### why this is better

- one browser bootstrap path
- no HTML parsing in assembly
- no rewriting of `<script type="module">`
- fewer package-specific document assumptions
- easier builtin standardization

## builtin migration plan

Builtin apps currently use HTML browser entries in several places, for example:

- [builtin-packages/files/src/package.ts](/home/hank/theagentscompany/gsv/builtin-packages/files/src/package.ts:1)
- [builtin-packages/chat/src/package.ts](/home/hank/theagentscompany/gsv/builtin-packages/chat/src/package.ts:1)

### migration steps

1. Change `app.browser.entry` from `./src/index.html` to `./src/main.ts` or `./src/main.tsx`.
2. Move any boot scripts from HTML into JS imports.
3. Move stylesheet loading to explicit `app.assets`.
4. Remove package-specific HTML scaffolding that is now owned by the platform shell.

### compatibility strategy

The cleanest path is:

- add v2 JS-entry support with the JS-only contract already enforced
- migrate builtins onto JS entries as part of the rollout
- do not carry forward HTML-entry compatibility into the new assembler path

Do not keep HTML-entry support indefinitely if the goal is to simplify the
package surface.

## protocol compatibility

The transport contract can remain mostly stable.

### can stay the same

- `PackageAssemblyRequest`
- `PackageAssemblyResponse`
- artifact module kinds
- target name

### should change in semantics

- `definition.app.browser_entry` should be interpreted as a module entry path,
  not an HTML document path

If needed, a future protocol revision can rename this field for clarity, but v2
does not require a protocol rename to start implementation.

## implementation milestones

### milestone 1

- finalize v2 contract
- enforce JS-only browser entry
- define diagnostic code families

### milestone 2

- implement virtual npm installer
- preserve workspace materialization
- support `package-lock.json`

### milestone 3

- implement `oxc_resolver`-based graph resolution on virtual FS
- emit module graph without bundling

### milestone 4

- implement Oxc TS / JSX transform stage
- emit ESM / CJS / JSON / text modules

### milestone 5

- implement runtime wrapper generation
- implement fixed HTML shell integration

### milestone 6

- migrate builtin packages
- remove HTML entry support

## open questions

- Should the installer support a registry mirror / allowlist policy from day one?
- Should v2 preserve the current SDK fallback injection behavior exactly, or tighten it?

These are implementation details to settle during rollout, not architecture
blockers.

## summary

v2 intentionally narrows the package assembly contract.

That is the point.

We want:

- explicit stages
- deterministic installs
- virtual-FS resolution
- Oxc transforms
- Dynamic Worker module emission
- fixed shell browser boot
- structured diagnostics

We do not want:

- an embedded general-purpose bundler runtime
- package-authored HTML as the primary app entry contract
- opaque build failures
