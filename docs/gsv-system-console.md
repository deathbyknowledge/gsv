# GSV System Console

This document defines the product and navigation contract for the consolidated `GSV` builtin app.

The app is a system console for operating and configuring a GSV installation. It is not a folder of former builtin apps, and it should not look or behave like a generic web dashboard.

## Product Job

`GSV` owns the control-plane experience:

- what needs attention
- what is running
- what machines and external surfaces GSV can reach
- what code is installed, trusted, and updateable
- who or what has access
- how the runtime is configured

It should not absorb the main work surfaces:

- `Chat` remains the conversation and agent workspace.
- `Files` remains the filesystem browser/editor.
- `Shell` remains the terminal surface.
- `Wiki` remains the knowledge product.
- demos such as `ascii-starfield` remain outside the console.

## UX References

Use native-feeling app patterns as the reference point:

- GitHub Mobile: attention-first queues and object drill-downs.
- iOS Settings: grouped lists, search, and navigation stacks.
- Linear: dense operational lists with fast detail surfaces.

Avoid web dashboard patterns:

- hero sections
- large stat-card grids
- decorative gradients
- marketing spacing
- stacked cards for every section
- raw key/value dumps as the main surface

The visual target is a native-feeling operations console inside the GSV desktop shell.

## Global Navigation

Global navigation chooses the kind of work. It should stay small and grouped.

```text
GSV
+-- Overview
+-- Operations
|   +-- Runtime
|   +-- Devices
+-- Extensions
|   +-- Packages
|   +-- Integrations
+-- Administration
    +-- Access
    +-- Settings
```

Do not make every former app a top-level destination. Former app boundaries become local feature modules where they fit the system-console job.

## Section Responsibilities

### Overview

Overview is an attention inbox, not a dashboard.

It should collect things that need operator attention:

- packages requiring review
- available package updates
- offline or unhealthy devices
- disconnected adapters
- unhealthy MCP servers
- suspicious or long-running processes
- expiring or recently issued credentials

Each row should state the object, the reason it matters, and where to fix it.

### Runtime

Runtime owns process inspection and control.

Primary actions:

- search/filter processes
- inspect process detail
- open a process in `Chat`
- stop a process

Runtime must not become Chat.

### Devices

Devices owns fleet and node lifecycle.

Primary actions:

- inspect online/offline state
- review capabilities and health
- provision a new node
- manage device access
- open `Files` or `Shell` as companion actions

Devices should not replace Files or Shell.

### Packages

Packages owns package lifecycle.

Primary actions:

- review trust decisions
- install or remove packages
- inspect updates
- manage sources and remotes
- browse package source when needed

Packages has enough depth to keep its own local navigation inside the Packages section.

### Integrations

Integrations owns external systems GSV can talk to or use.

It should include:

- message adapters such as WhatsApp and Discord
- MCP servers and their tool readiness

Adapter account flows and MCP server flows are different local surfaces under the same global question: what external surfaces are connected?

### Access

Access owns identity and authorization.

Primary actions:

- create and revoke user/API tokens
- review active tokens
- link and unlink external identities

Device enrollment tokens belong in Devices because they are part of node provisioning.

### Settings

Settings owns curated runtime configuration.

Primary actions:

- edit the settings users actually need
- keep raw or unmodeled config in Advanced

Advanced is an escape hatch, not the design center.

## Shell Behavior

Desktop layout:

```text
[grouped nav] [section top bar] [section workspace]
```

Mobile layout:

```text
[top bar with title/back/actions]
[focused screen]
[bottom grouped nav: Overview | Operations | Extensions | Admin]
```

Rules:

- Desktop gets persistent grouped navigation.
- Mobile gets bottom grouped navigation plus top title/back/action chrome.
- Mobile bottom nav uses groups, not one tab per former app.
- Global navigation chooses the work category.
- Local navigation chooses object state inside the section.
- Never show both global nav and local nav as sidebars on mobile.
- Use list-to-detail stacks on mobile.
- Convert tables to object rows on mobile.
- Keep destructive actions inside detail screens unless clearly reversible.
- Put search inside the section it filters.

## Route Contract

Use one `section` parameter for global location and section-specific parameters for local state.

```text
/apps/gsv?section=overview
/apps/gsv?section=runtime&q=...
/apps/gsv?section=devices&device=...&tab=health
/apps/gsv?section=packages&view=review&package=...&tab=summary
/apps/gsv?section=integrations&type=adapters&adapter=whatsapp&account=primary
/apps/gsv?section=access&tab=tokens
/apps/gsv?section=settings&category=ai
```

Former app ids can remain as compatibility launchers during migration and should deep-link into the matching `GSV` section once the feature has moved.

## Permission Model

`GSV` will eventually be a high-privilege first-party console. Permissions must be visible in the product:

- do not render editable controls that can only fail at save time
- show read-only state clearly
- disable or hide admin actions based on viewer permissions
- keep personal override surfaces separate from root-only system flows

The privilege caveat is intentional: one app can own the system console, but it must not blur permission boundaries in the UI.

## Migration Plan

1. Add the `GSV` shell and navigation contract.
2. Keep old builtin apps available as compatibility surfaces.
3. Refactor existing apps into feature-shaped modules before moving them.
4. Move `control`, `devices`, `processes`, and `adapters` features first.
5. Refactor `packages` in place before moving it into `GSV`.
6. Retire old app ids only after deep links and package sync behavior are settled.

Keep the shell contract stable while individual features migrate.
