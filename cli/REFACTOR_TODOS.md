# CLI refactor TODOs

The current CLI shape mixes argument schema, app dispatch, auth/setup flows,
gateway command implementations, node runtime, service management, and deploy
UX in a few large files. Refactor in small compiler-checked slices.

## Target boundaries

- `cli.rs`: Clap argument schema only.
- `app.rs`: top-level parse/config/dispatch flow.
- `auth_flow.rs`: setup/login/logout, cached session token handling, and
  auth/setup retry wrappers.
- `commands/`: gateway-facing user commands grouped by domain:
  `chat`, `config`, `packages`, `auth`, `adapter`, `proc`, and `infra`.
- `device/`: node runtime, local shell bridge, install/upgrade/uninstall, and
  service management entrypoints.
- `commands/infra.rs`: infrastructure command UX that calls the existing
  deployment library in `gsv::deploy`.
- `config.rs`, `connection.rs`, `kernel_client.rs`, `protocol.rs`, `transfer.rs`,
  and `tools/`: library support used by the binary and tests.

## Slices

- [x] Extract Clap command definitions from `main.rs` into `cli.rs`.
- [x] Extract setup/login/logout and auth retry logic into `auth_flow.rs`.
- [x] Convert `commands.rs` into a `commands/` module directory.
- [x] Split gateway commands into focused files under `commands/`.
- [x] Move node runtime and service orchestration out of `main.rs`.
- [x] Move deploy command prompting/dispatch out of `main.rs`.
- [x] Reduce `main.rs` to runtime bootstrap plus `app::run()`.
- [x] Run `cargo fmt`, `cargo check`, and the focused CLI tests after each
      meaningful slice.

## Follow-up TODOs

- [ ] Consider splitting `auth_flow.rs` further if setup/login/session-cache
      behavior grows.
- [ ] Consider turning the deployment library into a `deploy/` module tree if
      Cloudflare deploy internals need deeper cleanup.
