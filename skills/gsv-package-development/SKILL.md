---
name: gsv-package-development
description: Create or modify GSV package apps and package CLI commands, including scaffold, manifest, staged source edits, commit, checkout, and sync.
---

# GSV Package Development

## When to Use

Use this skill when the user asks you to build, modify, validate, or ship a reusable GSV package, package app, package CLI command, or package-owned workflow.

## Procedure

1. Inspect package state with `pkg list`, `pkg show <package>`, `pkg manifest <package>`, and `pkg source status <package>`.
2. For a new user-owned package, run `pkg create --repo <username>/<repo> --template web-ui|command --enable`. Use the current user's repo owner unless the user explicitly asks for another owner.
3. Edit source under `/src/packages/<package>`. When cwd is inside that tree, most `pkg source` commands can infer the package.
4. Keep the manifest in `src/package.ts`. Browser apps use `browser.entry`; backends use `backend.entry`; CLI commands use `cli.commands`.
5. Declare only the Kernel grants the package entrypoints need. Use `repo.*` for repository content operations and `pkg.*` only for package lifecycle operations.
6. Make narrow edits. User-owned package writes are staged for the process until committed.
7. Validate with the package's local checks when available, such as TypeScript, package tests, or a focused command run.
8. Review staged changes with `pkg source status <package>` and `pkg source diff <package>`.
9. Commit source edits with `pkg source commit <package> --message "..." --branch <branch>`.
10. Use `pkg checkout <ref> <package>` when the installed package should move to a committed ref. Builtin package sync is separate and is normally done with `gsv packages sync` after the `root/gsv` source has been updated.

## Pitfalls

- Do not confuse package sync with pulling upstream. Pulling updates the local ripgit source from its upstream; syncing reassembles the package from the source ref it already points at.
- Do not invent package source paths. Use `pkg list`, `pkg show`, and `/src/packages/<package>`.
- Do not treat package source edits as installed until the package has been committed and synced or checked out as needed.
- Do not use broad package capabilities because a syscall is convenient. Capabilities are part of the package's trust contract.
- Do not commit staged package edits during review unless the user explicitly asked for authoring work.
