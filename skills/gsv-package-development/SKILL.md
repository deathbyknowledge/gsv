---
name: gsv-package-development
description: Guide on how to build and modify GSV packages, including source checkout, app/backend/CLI changes, manifests, validation, staged commits, and syncing.
---

# GSV Package Development

## Start From Package State

Use native shell on `target: "gsv"`:

```bash
pkg list
pkg show <package>
pkg manifest <package>
pkg source <package>
```

Do not invent source paths. Use `pkg source <package>` to find the package source path under `/src/repos/{owner}/{repo}/{subdir}`. When cwd is inside a repo, use `rgit --here` forms for repo operations.

## Create a User-Owned Package

Use the current user's repo owner unless the user explicitly asks for another owner:

```bash
pkg create --repo <username>/<repo> --template web-ui --enable
pkg create --repo <username>/<repo> --template command --enable
```

Then edit the package source path reported by `pkg source <package>`.

## Manifest Shape

Keep the manifest in `src/package.ts`. Browser apps use `browser.entry`, backends use `backend.entry`, and CLI commands use `cli.commands`.

Declare only the Kernel grants the package entrypoints actually need:

- use `fs.*` for filesystem work
- use `repo.*` for ripgit repository content
- use `pkg.*` only for package lifecycle operations
- use adapter/process/scheduler grants only when the code directly needs them

Capabilities are part of the package trust contract. Do not broaden them to make development convenient.

## Edit and Validate

1. Read source before editing.
2. Make narrow changes.
3. Validate with package-local checks when available, such as TypeScript, tests, or a focused command run.
4. Inspect staged source changes:

```bash
rgit status --here
rgit diff --here
```

Source writes are staged per process for ripgit-backed package source. They are not installed or shared until committed.

## Commit, Checkout, and Sync

Commit staged source edits:

```bash
rgit commit --here --message "short imperative message" --branch <branch>
```

Move an installed package to a committed ref:

```bash
pkg checkout <ref> <package>
```

Builtin package sync is a host CLI workflow after `root/gsv` has the desired source:

```bash
gsv packages sync
```

Pulling upstream, checking out a ref, and syncing are different:

- upstream pull refreshes a local ripgit source from a remote branch
- checkout moves the installed package pointer to a ref
- sync re-seeds and reassembles builtin packages from `root/gsv`

## Pitfalls

- Do not treat staged package source edits as installed behavior.
- Do not commit package edits during review unless the user changes the task to authoring.
- Do not use raw GitHub URLs for custom GSV packages unless the package is intentionally backed by a GitHub upstream.
- Do not use broad grants because a syscall is nearby.
- Do not confuse host `gsv packages sync` with native package source commit/checkout.
