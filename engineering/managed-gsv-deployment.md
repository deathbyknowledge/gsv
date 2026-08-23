# Composing a managed GSV deployment

The public repository provides the Gateway, host applications, adapters, and
versioned Worker RPC contracts under `packages/gsv/src/services/`. It does not
ship a platform operator's account directory, billing system, entitlements,
provider credentials, or funded-inference implementation.

A managed operator supplies at least:

- an `InstallationDirectoryService` that maps accepted hostnames to immutable
  installation IDs without allocating state for unknown hosts;
- an `InstallationOnboardingService` that issues and consumes one-time setup
  authorization;
- an `InferenceService` when the platform funds or centrally routes model
  traffic;
- optionally an `EntitlementsService` and `MailService` for deployment policy
  and managed mail operations.

Adapters are a separate, open extension boundary. Each trusted adapter Worker
implements `AdapterService`; it does not need to be part of the platform
operator's private service source.

## Composition

Bind service implementations explicitly to the Gateway. A binding grants only
the callable interface configured by the deployment; it does not carry browser
identity or let a caller choose an installation ID. The Gateway derives the
installation from trusted hostname routing, while adapters derive it from
their durable links.

The included managed Wrangler configs and scripts are development references.
To use them, point `GSV_MANAGED_SERVICES_ROOT` at a directory with `accounts/`
and `inference/` packages implementing the public contracts:

```bash
GSV_MANAGED_SERVICES_ROOT=/path/to/operator/services npm run dev:managed
GSV_MANAGED_SERVICES_ROOT=/path/to/operator/services npm run managed:check
```

Production infrastructure should own Worker names, routes, secrets, databases,
queues, migration application, retained state, plans, and rollback. Do not mix
two deployment owners against the same live environment.

## Release discipline

Validate both sides of every contract change: the public consumer and the
operator implementation. Deploy additive service changes before consumers that
require them. Worker rollback does not roll back D1, R2, Queue, or Durable
Object state, so migrations remain forward-only.

Standalone deployments omit the managed bindings entirely. They retain the
`singleton` installation projection, user-selected inference providers, and
any adapters selected by their owner.
