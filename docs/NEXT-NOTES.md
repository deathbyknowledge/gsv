# next notes

This document groups the next batches of design and implementation work after the package migration checkpoint.

It is intentionally short and decision-oriented.

## batch 1: package sdk

Goal:
- Make it clear how first-party and third-party authors write package apps.

Questions to settle:
- What is the server-side package worker API?
- What is the browser-side `HOST` API?
- What is the minimal package directory contract?
- What parts are runtime contracts vs build-time sugar?

Expected outputs:
- `@gsv/package-worker` surface
- `@gsv/package-host` surface
- package entrypoint conventions
- package manifest validation rules

Current direction:
- Keep raw Dynamic Worker as the runtime substrate.
- Put a thin GSV SDK on top of it.
- Keep package authoring constrained to JS/TS/JSX/TSX.
- Do not expose raw kernel objects or raw DOs.

Open design points:
- How much capability inference should the SDK/build pipeline do automatically?
- How much should be explicit in `gsv-package.json`?
- Whether package worker code should stay mostly HTTP-first, with async frame hooks added later.

## batch 2: ripgit core vs ripgit packages

Goal:
- Keep ripgit as the general version-controlled workspace substrate while adding a first-class package workflow on top.

Model:
- `ripgit core`
  - repos
  - refs
  - commits
  - trees
  - diffs
  - branch operations
- `ripgit packages`
  - package detection via `gsv-package.json`
  - package analysis
  - package build/bundle
  - diagnostics
  - artifact cache

Important decision:
- Do not replace the generic workspace story with a package-only story.
- Packages are a specialized layer on top of version-controlled directories, not a different storage system.

Expected outputs:
- ripgit package API
- `repo + ref + subdir + resolvedCommit` flow
- package-aware diagnostics and caching model

## batch 3: oxc and oxlint in the package pipeline

Goal:
- Use a Rust-native JS/TS toolchain for package analysis and build work.

Current assumption:
- OXC fits well for parse/transform/build-time analysis.
- Oxlint fits well for live feedback and package diagnostics.

Likely responsibilities:
- parse TS/JS/JSX/TSX package source
- validate package entrypoints
- infer import graph
- validate capability usage against manifest declarations
- transform package SDK sugar into runtime-compatible output
- emit diagnostics continuously during editing

Important constraint:
- Keep this as declarative package tooling.
- Do not introduce arbitrary user-defined build scripts into the kernel install path.

What to avoid:
- letting each package choose its own bundler/linter/runtime pipeline
- treating OXC as the source-control layer
- making runtime package loading depend on ad hoc shell hooks

## batch 4: package build contract

Goal:
- Define the v1 `gsv-package.json` build contract clearly enough that ripgit can build packages deterministically.

Questions to settle:
- What entrypoint kinds are allowed?
- How are static assets declared?
- What output targets do we support?
- What gets bundled vs copied as-is?

Current direction:
- JS/TS/JSX/TSX only
- deterministic artifact output
- content-addressed artifact hashing
- static assets copied declaratively
- no arbitrary lifecycle scripts in kernel/runtime build paths

Expected outputs:
- `gsv-package.json` v1 design
- target/build field definitions
- artifact emission rules

## batch 5: resolved commit and source identity

Goal:
- Finish the package source model cleanly.

Still missing:
- `resolvedCommit` is not yet stored properly in the active package flow.

Why it matters:
- install records should capture both:
  - requested `ref`
  - actual `resolvedCommit`
- branch switching should remain convenient
- runtime identity should remain deterministic

Expected outputs:
- ripgit ref resolution API
- package install record updates
- package manager UI visibility for `ref` and `resolvedCommit`

## batch 6: package runtime capabilities

Goal:
- Implement the first real package-local state surface.

Current direction:
- every installed package has one Package DO
- package code should not know it is talking to a DO
- first surface should be:
  - `sqlExec(...)`
  - `sqlQuery(...)`

Deferred for later:
- alarms
- richer state declarations
- larger runtime abstractions

Expected outputs:
- real `PACKAGE` binding
- Package DO state path exercised by at least one package

## batch 7: host contract and multi-host runtime

Goal:
- Freeze the runtime-agnostic `HOST` contract so browser and future daemon/webview hosts implement the same surface.

Hosts we care about:
- web desktop shell
- future `wry` desktop/webview host

Important boundary:
- `HOST` is app-facing transport
- `KERNEL` is trusted server-side package worker binding
- they must stay separate

Likely next design work:
- formal `HOST` API document
- host-managed lifecycle for app-spawned processes
- signal delivery and teardown rules

## batch 8: shared package app surface

Goal:
- Avoid each package app reinventing all UI foundations while keeping the shell/app boundary clean.

Current state:
- `/runtime/theme.css` exists
- package apps otherwise mostly roll their own markup/styles

Likely additions:
- tiny shared CSS layer
- minimal app-shell patterns
- conservative shared JS helpers if needed

Important constraint:
- do not recreate the old monolithic UI bundle
- keep shared runtime assets small and stable

## batch 9: future async app routing

Goal:
- Let package apps become first-class async frame endpoints when we actually need it.

Current state:
- routing table supports `connection` and `process`
- package workers currently use the v1 synchronous `KERNEL.request(...)` path

Future direction:
- add `app` as a kernel routing origin
- support async `res` and `sig` delivery to package app runtimes
- let SDK/runtime own response correlation plumbing

Important note:
- This is not the next thing to implement.
- It should be done when a real package/runtime use case demands it.

## recommended order

1. Define the package SDK surface.
2. Define the ripgit package API and monorepo package directory contract.
3. Define the `gsv-package.json` v1 build contract.
4. Finish `resolvedCommit`.
5. Implement the real `PACKAGE.sql*` path.
6. Freeze the `HOST` contract and host-managed process lifecycle.
7. Expand the shared package app surface conservatively.
8. Revisit async `app` routing only when needed.
