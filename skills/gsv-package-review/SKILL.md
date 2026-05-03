---
name: gsv-package-review
description: Review, import, approve, enable, update, or publish GSV packages safely from source, refs, capabilities, and package metadata.
---

# GSV Package Review

## When to Use

Use this skill when the task is to inspect, approve, enable, update, publish, or reject a GSV package. Use `gsv-package-development` instead when the task is to author code.

## Review Procedure

1. Start from package metadata:

```bash
pkg list
pkg show <package>
pkg manifest <package>
pkg capabilities <package>
pkg refs <package>
pkg log <package> --limit 20
```

2. Inspect source under `/src/packages/<package>`. Prefer direct source evidence over manifest summaries.
3. Check `pkg source status <package>`. A review should usually start from clean source. Explain any staged edits before trusting the tree.
4. Identify browser, backend, CLI, public route, daemon, and package profile entrypoints.
5. Compare requested Kernel capabilities to the code paths that actually need them.
6. Call out risky behavior explicitly: filesystem writes/deletes, shell execution, repo mutation, package lifecycle calls, process spawning, adapter calls, public routes, network access, eval-like execution, parent-window messaging, and broad grants.
7. Separate verdict from enablement. Approval means the package is trusted for its requested grants; enablement makes entrypoints active.

## Commands

```bash
pkg add --repo owner/repo --ref main --subdir . 
pkg approve <package>
pkg enable <package>
pkg disable <package>
pkg checkout <ref> <package>
pkg public on <package>
pkg public off <package>
```

Use mutating commands only when the user asked for that action.

## Pitfalls

- Do not commit staged source edits during package review unless the user explicitly changes the task to authoring.
- Do not approve based only on display name, description, or UI appearance.
- Do not treat `pkg approve` and `pkg enable` as the same operation.
- Do not confuse package sync, checkout, and upstream pull. Checkout moves an installed package to a ref; sync reassembles from the current source ref; upstream pull refreshes local source from a remote.
