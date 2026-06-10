# Trust, Entrypoints & Source Workflows

[Packages & Extensions](index.md)

## Installing And Enabling

Installing makes a package available. Enabling activates its entrypoints. A disabled package may remain installed for review, source work, or later use.

Before enabling a package, check:

- What apps, commands, agents, backend services, or public routes it adds.
- What permissions it requests.
- Who will use it.
- Whether it comes from a trusted source.

## Package Review

Review is most important for packages that request file access, shell access, credentials, external messaging, public routes, or system settings access.

Look for:

- Clear manifest and capability requests.
- Narrow permissions.
- Source that matches the advertised purpose.
- No hidden credential handling.
- Public routes that verify incoming requests.
- Reasonable package agent behavior.

## Entrypoints

Entrypoints are the ways a package appears in GSV:

- App entrypoints open desktop UI.
- Command entrypoints run from Shell or package command surfaces.
- Backend entrypoints handle package logic.
- Agent entrypoints provide package-specific assistants.
- Public route entrypoints receive external web requests when declared.

## Source Workflows

Package source may be mounted for editing and review. Some source changes are staged until committed or discarded. Editing package source is not always the same as updating the installed running package.

## For Agents

When reporting a package change, say whether you installed, enabled, approved, committed source, discarded source, or updated a running package. These are different actions.
