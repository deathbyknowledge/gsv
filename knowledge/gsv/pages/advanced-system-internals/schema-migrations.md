# Schema & Migration Guidance

[Advanced System Internals](index.md)

GSV uses versioned schema migrations for durable stores. Do not create ad hoc schema changes from store constructors or runtime repair code unless the owning system explicitly supports that pattern.

## Migration Owners

- Gateway kernel schemas: `gateway/src/kernel/schema/*`
- Process runtime schemas: `gateway/src/process/schema/*`
- App runner schemas: `gateway/src/app-runner/schema/*`
- Shared TypeScript runner schema: `gateway/src/schema/runner.ts`
- ripgit repository worker schema: `ripgit/src/schema.rs`

## Rules

- Add the next numbered migration for shipped schema changes.
- Do not edit a migration that has already shipped in a release.
- Collapse into a new baseline only before a release or during an explicit major-version reset.
- Keep old migrations long enough for supported upgrade paths.
- Validate the owner of the schema, not only the code that reads it.

## Validation Examples

- Gateway runtime or syscall schema work: run gateway typecheck and tests.
- Process runtime schema work: run process and migration tests.
- App runner schema work: validate the app runner and relevant package behavior.
- ripgit schema work: validate the Rust worker tests.

## For Agents

If a task asks for schema recovery or migration repair, pause before editing. Identify the owning store, current version, expected upgrade path, and whether the change is a one-time repair or a shipped migration.
