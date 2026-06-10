# Source Maps, Updates & Debugging

[Advanced System Internals](index.md)

Use this page when changing GSV itself or debugging which layer owns a behavior.

## Source Map

- Gateway control plane: `gateway/src/*`
- Process runtime: `gateway/src/process/*`
- Syscall surface: `gateway/src/syscalls/*`
- Web shell: `web/src/*` and `web/public/*`
- Builtin apps: `builtin-packages/*`
- Adapter workers: `adapters/whatsapp/*`, `adapters/discord/*`, and `adapters/test/*`
- CLI: `cli/*`
- ripgit: `ripgit/*`
- Shared contracts: `shared/*`
- Product and design references: `docs/*` and `engineering/*`
- Shipped manual content: `knowledge/gsv/*`

## Update Paths

- Gateway changes: `cd gateway && npm run deploy`
- Gateway local validation: `cd gateway && npx tsc --noEmit && npm run test:run`
- Web shell changes: `cd web && npm run check && npm run build`
- Builtin package changes: push the source branch and run package sync from the CLI.
- WhatsApp adapter changes: `cd adapters/whatsapp && npx tsc --noEmit`
- Discord adapter changes: `cd adapters/discord && npm run typecheck`
- Test adapter changes: `cd adapters/test && npm run typecheck`
- CLI changes: `cd cli && cargo test && cargo fmt --check`

## Debugging Boundaries

Check the surface that owns the problem:

- Login, desktop windows, previews, or browser target: web shell.
- Conversation history, queued input, tool approvals, media, or abort/reset behavior: process runtime.
- Package install, enablement, trust, or source workflow: package system.
- App UI behavior: the owning builtin or package app.
- External platform behavior: the specific adapter worker.
- Filesystem or command location confusion: target routing and devices.
- Knowledge search or Wiki editing: Wiki/package knowledge workflow.

## Source Of Truth

Do not assume the repository, deployed worker, installed package, and live runtime state are identical. A debugging note should say which one was inspected.
