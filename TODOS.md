# TODOs

## Current checkpoint

This branch has the package review architecture replacement in progress:

- Review processes no longer depend on bespoke AI package tools as the intended model.
- Review processes start in the package source directory under `/src/repos/{owner}/{repo}/{subdir}`.
- A native `pkg` shell command is being added as the package control surface.

## Done recently

- Reworked core built-in apps toward OS-style interiors:
  - Files
  - Shell
  - Chat
  - Control
  - Devices
  - Processes
  - Packages
- Added upstream bootstrap flow for `root/gsv`.
- Fixed CI after the `gateway-os -> gateway` rename.
- Added third-party package review gating:
  - imported third-party packages default disabled
  - approval required before enabling

## In progress now

### Replace bespoke package review tools with pkg CLI

Goal:
- Remove the agent-facing dependency on `PackageRefs`, `PackageRead`, and `PackageLog`.
- Make review feel like inspecting package source through normal fs/shell tools.

Implemented in this slice:
- `KernelContext.processId`
- `/src/repos/*` ripgit-backed source backend
- FS and shell drivers wired to source and repo paths
- Review process now spawns with cwd at package source
- Review prompt rewritten to use shell/fs/`pkg`
- AI tool exposure for bespoke package repo tools removed from `ai.tools`

Still to verify/fix:
- Runtime behavior of package review cwd
- `pkg` command behavior and output polish
- Remove any remaining dead code/wiring around old package repo review tools if no longer needed anywhere

## Next tasks

### 1. Validate and finish the new package review model

- Verify review process opens with cwd at package source
- Verify the reviewer can use:
  - `pwd`
  - `ls`
  - `find`
  - `grep`
  - `cat`
  - `pkg manifest`
  - `pkg capabilities`
  - `pkg source`
  - `rgit status --here`
  - `rgit diff --here`
- Verify approval flow still works from Packages after review

### 2. Add tests for the new package review architecture

Backend coverage to add:
- review spawn cwd selection
- source backend read/tree behavior
- `pkg` CLI subcommands:
  - `list`
  - `manifest`
  - `capabilities`
  - `refs`
  - `log`
  - `approve`
  - `enable`
  - `disable`
  - `checkout`
- third-party package remains disabled until approved

### 3. Packages product polish

- Improve imported vs installed repo/package visibility
- Improve capability review presentation
- Decide how much repo management belongs in Packages UI vs `pkg` CLI
- Consider public read-only repos on GSV servers:
  - explicit public repo visibility flag
  - unauthenticated clone/fetch only
  - never implicit enable

### 4. Bootstrap/onboarding polish

- Better custom upstream UX in onboarding
- Later: split onboarding into:
  - Quick start
  - Customize
  - Advanced
- Long-term: AI-guided onboarding over a structured state machine

### 5. Platform follow-ups

- Replace full upstream fetches with incremental `have` negotiation later
- Decide whether `pkg` should be the only user-facing package CLI and keep `ripgit` internal/expert-only
- Clean up any remaining CI/test warning noise

## Important architectural decisions

- `pkg` is the correct user/agent-facing package abstraction.
- `ripgit` should remain implementation detail or expert-facing.
- Package review should happen through:
  - visible package source trees
  - normal fs/shell exploration
  - `pkg` command
- Process profiles remain fixed system roles.
- User-definable behavior should layer on top later, not replace system profiles.

## Notes for resuming

Likely first command sequence when resuming:

1. inspect `git status`
2. run gateway typecheck/tests if needed
3. push + sync builtins to exercise review flow
4. test a real third-party review end to end in Packages/Chat
