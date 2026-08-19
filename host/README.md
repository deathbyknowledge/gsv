# Rust host software

This directory contains software that runs on a user's computer rather than in
the GSV control plane.

```text
host/
├── apps/
│   ├── cli/       # `gsv` operator client
│   ├── desktop/   # `gsv-desktop` GPUI application
│   └── machine/   # `gsvd` machine driver
├── helpers/
│   ├── gestures/  # isolated camera and gesture process
│   └── transcriber/ # isolated microphone and speech process
└── crates/
    ├── config/
    ├── desktop-protocol/
    ├── gateway-client/
    └── gesture-protocol/
```

Cargo package names describe architectural responsibilities. Installed binary
names remain stable where they are part of an existing distribution or service
contract. See
[`docs/architecture/rust-host-applications.md`](../docs/architecture/rust-host-applications.md)
for ownership and lifecycle details.
