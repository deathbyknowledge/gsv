# GSV App Surface Design

GSV's web UI is Instrument: Zen, Fleet, Memory and Settings share one shell. These surfaces should make important state and actions obvious, avoid generic dashboard behavior, and expose raw data only for a specific inspection or recovery job. The native Desktop client is a separate surface.

## Start With The App Job

When designing or rewriting a GSV app surface, do not start from the current code shape or from whatever UI happens to exist today. Start from the product job of the app.

Write down:
- what job the app owns
- what questions it should answer at a glance
- what primary actions it must make easy
- what belongs somewhere else and should not be duplicated here

If you cannot state the app's job clearly, stop and design first.

Examples:
- `Zen` owns conversation, messages, run activity, approvals and direct shell commands
- `Fleet` owns places, processes, contacts, responsibilities, routines, the ledger and files
- `Memory` owns reading, finding, creating and correcting pages
- `Settings` owns model preferences, instructions, permissions, connections and timezone

## Design From Decisions

Do not build the UI by dumping every field returned by a syscall. A syscall shape is an implementation detail, not a product design.

Instead:
- identify the decisions the user needs to make
- identify the state they need in order to make those decisions confidently
- design the UI around those decisions
- then map the design to the backend/syscalls

Bad pattern:
- render every config key because `sys.config.get` returned them

Good pattern:
- surface the curated settings people actually need
- leave low-value implementation controls to Ship or commands

## Prefer Task-Oriented Surfaces

Most apps should be organized around tasks, not raw records.

Good examples:
- pair a device
- open a workspace on a target
- inspect a process and stop it
- rotate a token
- save a prompt policy

Avoid:
- giant key/value tables as the main UI
- pages that only mirror backend objects without interpretation
- generic forms that expose every field with no explanation

## Show Important State Quickly

Every app should make the most important state immediately obvious.

Ask:
- what must the user be able to see in under five seconds?
- what should be sortable, grouped, or highlighted first?
- what deserves a dedicated summary instead of being buried in detail?

Examples:
- Fleet places: online/offline, platform, owner and reachability
- Fleet processes: running/completed/error, label, owner and last activity
- Fleet files: current target, path, dirty state and preview type

## Keep Scope Boundaries

Do not casually merge responsibilities because the data is nearby. If a concern belongs to another app, link to that app instead of re-implementing it.

Examples:
- a place inspector can open its files or a command in Zen
- Settings manages preferences and connections; Fleet inspects live work
- a process inspector can open its visibly labelled conversation in Zen

A GSV app surface should have a clear center of gravity.

## Use The Shared Instrument Shell

The star field and header persist while changing views. Each surface owns its content and scrolling area. Use the shared navigation and keep the surface focused on its operational job.

Prefer:
- split panes
- sidebars/rails
- detail panes
- tables where appropriate
- dense but readable layouts
- direct manipulation and clear primary actions

Avoid by default:
- stacked rounded cards for every section
- flashy dashboard tiles
- oversized marketing spacing
- layouts that waste vertical space on repeated explanatory chrome

The app should feel like a serious workstation tool.

## Follow The Instrument Contract

Use [Instrument](../web/src/app/features/instrument/README.md) and [Settings](../web/src/app/features/instrument/settings/README.md) as the product and interaction contracts.

Instrument is the default web entrypoint. The former desktop and console routes have no compatibility mapping. Login and installation onboarding enter the same UI; the first-day introduction is Zen's empty state. The design catalog remains a separate development surface and loads only when opened.

Core rules:
- global navigation chooses the kind of work; tables and inspectors choose the object
- retain one header and background across views, including narrow layouts
- use lists, panes, inspectors and queues; avoid decorative dashboards
- apply the documented text/block button policy consistently
- show permission state before actions
- keep shared gateway, history, file, contact and model logic in browser services and domain modules, independent of presentation

## Match Controls To Data

Do not use one generic input type everywhere. Match the control to the data and the action.

Examples:
- boolean: checkbox or toggle
- enum: select
- short scalar: text or number input
- long prompt/policy text: textarea
- structured but advanced policy: dedicated JSON editor only when needed
- destructive action: explicit button with clear label

If a field is important but hard to understand, add a short description. Expose implementation settings only when the user has a meaningful decision to make.

## Keep Raw Power In Advanced

For apps that need a power-user escape hatch:
- keep the main surface curated and intentional
- keep raw/unmodeled state in `Advanced`
- do not let `Advanced` dictate the structure of the main app

`Advanced` is for:
- unmodeled keys
- raw JSON
- low-level policy artifacts
- debugging and recovery

It is not the design center of the app.

## Treat Permissions As Product

Do not render an editable UI and wait for save-time permission errors.

If a user cannot edit something:
- make it read-only in the UI
- show the lock state clearly
- explain the restriction with a concise tooltip or inline note when needed

If a user has a personal override surface:
- show that as a first-class path
- do not force them through a system-admin flow that will fail later

## Raise Architecture Debt

When a bug or awkward workflow points to a shared runtime, host, SDK, routing, or cross-app contract problem, call that out explicitly. Do not keep layering app-local patches over the same issue.

Examples:
- if multiple apps have to know another app's private route schema, the app-launch contract is wrong
- if one app works only through a special side channel while others hand-build URLs, the runtime boundary is wrong
- if the same host or RPC workaround keeps appearing, raise it as architecture debt before adding another copy

The standard is:
- identify whether the issue is local product/UI work or a shared systems issue
- if it is shared, say so directly
- prefer one runtime/host/API fix over several ad hoc app patches

## Preserve Behavior During Refactors

A migration to SPA, RPC, or a new runtime is not permission to redesign the product.

If you are changing architecture, rendering model, state management, or transport, preserve:
- the app's job
- the user's primary workflows
- the established visual direction

Only change product behavior when there is an explicit reason to do so.

## Write A Short Spec For New Apps

Before implementing a new app or turning a mock into a real product, write down:
- app job
- primary user questions
- primary actions
- main views/panes/tabs
- what is intentionally out of scope

This does not need to be long, but it should exist before implementation starts.

## Minimum Checklist

Before coding a GSV app surface, be able to answer:
- What job does this app own?
- What should be visible at a glance?
- What are the top three user actions?
- What belongs in another app instead?
- What is the main layout shape: split pane, list/detail, editor, table, or wizard?
- Which data deserves a curated surface, and which belongs in `Advanced`?
- What permissions should change what is editable?
- Are we preserving the existing product behavior, or intentionally changing it?
