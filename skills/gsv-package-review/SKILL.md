---
name: gsv-package-review
description: Guide on how to review GSV packages before approval, including source inspection, manifests, capabilities, entrypoints, staged edits, refs, and trust boundaries.
---

# GSV Package Review

## Review Procedure

Start from metadata, then verify with source:

```bash
pkg list
pkg show <package>
pkg manifest <package>
pkg capabilities <package>
pkg source <package>
rgit refs --here
rgit log --here --limit 20
rgit status --here
```

A review should usually start from clean source. If staged edits exist, explain what they are before trusting the tree.

Inspect the path reported by `pkg source <package>` directly. Identify browser, backend, CLI, public route, daemon, signal, and package profile entrypoints.

## What To Check

- Requested Kernel capabilities match code paths that need them.
- Filesystem writes/deletes are scoped and intentional.
- Shell execution is justified and bounded.
- Repository mutation uses the correct repo and ref.
- Package lifecycle calls such as install, checkout, sync, approve, enable, and public visibility are justified.
- Process spawning, IPC, schedules, adapter calls, notifications, and public routes are explicit.
- Browser code does not abuse parent-window messaging or host bridge assumptions.
- Backend/public routes do their own webhook signature or route-specific authorization.
- Network access, dynamic import, eval-like behavior, and destructive actions are called out.

## Mutating Commands

Use these only when the user asked for that action:

```bash
pkg add --repo owner/repo --ref main --subdir .
pkg approve <package>
pkg enable <package>
pkg disable <package>
pkg checkout <ref> <package>
pkg public on <package>
pkg public off <package>
```

Approval and enablement are separate. Approval trusts a package for its requested grants. Enablement activates entrypoints.

## Verdict

Lead with findings when risks exist. End with one clear verdict:

- approve
- do not approve
- approve only after named fixes

Do not approve based on display name, description, screenshots, or UI polish alone.
