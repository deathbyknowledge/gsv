# Catalogs, Remotes & Public Visibility

[Packages & Extensions](index.md)

## Catalogs

A catalog is a list of packages available to install or review. Catalogs can represent builtin packages, local packages, organization packages, or remote sources.

Use catalogs to discover packages, compare available versions, and decide which packages should be visible to users.

## Remotes

Remotes connect package source to external or internal repositories. A remote may be used to pull updates, inspect source history, or publish package changes.

Before syncing from a remote, know whether the update changes source only, installed package state, enabled entrypoints, or public behavior.

## Public Visibility

Some packages expose public routes or user-visible catalog entries. Public visibility should be intentional.

Review:

- The exact public paths.
- Who can call them.
- Whether they need signatures, shared secrets, or OAuth.
- What data they can read or change.
- Whether logs might include sensitive data.

## Builtin Packages

Builtin package changes are applied through the package update workflow. A general system update does not necessarily update shipped app content.

## For Agents

Do not make a package public or connect a remote without confirming the intended audience and trust boundary.
