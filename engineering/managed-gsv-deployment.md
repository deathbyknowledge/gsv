# Managed GSV deployment runbook

This runbook owns the first production topology for the managed GSV service.
It does not enable customer traffic, select a Stripe merchant mode, approve a
model provider, or register the Telegram webhook. Those remain explicit release
gates.

The deployment invariant is that only the account service, managed Telegram
webhook, and installation Gateway have public routes. Inference and ripgit are
reachable only through service bindings. Standalone Workers keep their existing
names and configurations; a standalone deploy must never overwrite a managed
Worker.

## Fixed production inventory

| Component | Worker name | Public route | Stateful binding |
|---|---|---|---|
| Account control plane | `gsv-accounts` | `accounts.gsv.space/*` | D1 `gsv-accounts` |
| Installation Gateway | `gsv-managed-gateway` | `*.gsv.space/*` | Kernel and Process DOs, R2 `gsv-managed-storage` |
| Inference broker | `gsv-inference` | none | BudgetCoordinator DO |
| Shared Telegram adapter | `gsv-managed-telegram` | `telegram.gsv.space/*` | ManagedTelegramPeer DO |
| Repository service | `gsv-managed-ripgit` | none | Repository DO |

Cloudflare chooses the more specific account and Telegram routes ahead of the
wildcard Gateway route. All five configs disable `workers.dev` and preview URLs.
There is no dispatch namespace and no Workers for Platforms dependency.

The managed Gateway runs first for every shell navigation and resolves the
hostname before delegating to its static-assets binding. Only immutable,
installation-independent build assets (`assets`, fonts, icons, images, brand
marks, favicon, and web manifest) bypass directory lookup for edge-cache
performance. An unknown wildcard hostname therefore cannot receive the desktop
shell or allocate installation state.

The service-binding graph is intentionally cyclic:

```text
gsv-managed-gateway
  -> gsv-accounts:GatewayDirectoryEntrypoint
  -> gsv-inference:InferenceService
  -> gsv-managed-telegram:ManagedTelegramChannel
  -> gsv-managed-ripgit

gsv-accounts
  -> gsv-managed-gateway:GatewayEntrypoint
  -> gsv-inference:InferenceService
  -> gsv-managed-telegram:ManagedTelegramChannel

gsv-inference
  -> gsv-accounts:EntitlementReaderEntrypoint

gsv-managed-telegram
  -> gsv-managed-gateway:GatewayEntrypoint
```

The two account entrypoints deliberately expose different capabilities. The
Gateway can resolve hostnames and consume login handoffs, while inference can
only read entitlement projections.

## Validate without Cloudflare credentials

Install the repository, Telegram, and ripgit dependencies, then run:

```bash
npm run managed:check
```

The check validates exact Worker names, routes, service bindings, secret
ownership, state bindings, and the disabled inference release gate. It then
typechecks the affected packages, generates config-derived types into a
temporary directory, builds both web surfaces, and dry-runs all five Worker
bundles plus the clean-account bootstrap. It never calls a mutating Cloudflare
API.

## DNS

Worker routes do not create DNS records. Keep a proxied wildcard DNS record for
`*.gsv.space`; it covers installation hosts, `accounts.gsv.space`, and
`telegram.gsv.space`. The two exact Worker routes take precedence over the
wildcard route. Do not publish separate origin services for these hosts.

Before attaching routes, verify all three candidate URLs reach only the intended
Worker in a non-production zone or with the routes temporarily disabled.

## Fresh-account service bootstrap

Cloudflare requires a service-binding target to have an existing deployment
before the caller can be uploaded. Because the final graph contains cycles, a
brand-new account needs one placeholder deployment under each final Worker
name.

First inspect the five names in the Cloudflare dashboard and with
`wrangler deployments list --name <name>`. The placeholder is only for names
with no deployment. Never apply it to an existing Worker: doing so would replace
that Worker's code and bindings.

For each confirmed-new name, run the matching command from `gateway/`:

```bash
npm exec --workspaces=false -- wrangler deploy \
  --config ../deployment/managed/bootstrap/wrangler.jsonc \
  --name gsv-accounts

npm exec --workspaces=false -- wrangler deploy \
  --config ../deployment/managed/bootstrap/wrangler.jsonc \
  --name gsv-managed-gateway

npm exec --workspaces=false -- wrangler deploy \
  --config ../deployment/managed/bootstrap/wrangler.jsonc \
  --name gsv-inference

npm exec --workspaces=false -- wrangler deploy \
  --config ../deployment/managed/bootstrap/wrangler.jsonc \
  --name gsv-managed-telegram

npm exec --workspaces=false -- wrangler deploy \
  --config ../deployment/managed/bootstrap/wrangler.jsonc \
  --name gsv-managed-ripgit
```

The placeholder has no route, state binding, or secret. It returns `503` and
exports every named RPC entrypoint needed for final binding validation.

## Provision state

Provision the named R2 bucket once:

```bash
cd gateway
npm exec --workspaces=false -- wrangler r2 bucket create \
  gsv-managed-storage \
  --config wrangler.managed.jsonc
```

Apply D1 migrations before any account route becomes public:

```bash
cd account-service
npm exec --workspaces=false -- wrangler d1 migrations apply \
  ACCOUNT_DB \
  --remote \
  --config wrangler.jsonc
```

Current Wrangler can provision the named D1 binding when it does not exist. A
CLI deployment may write the resulting database ID into the local config; keep
that ID in the production deployment state and review the diff before any
commit. Never point staging at the production database.

Durable Object namespaces are established by the versioned migrations in each
final Worker config. Do not edit or renumber a shipped migration.

## Configure service-owned launch inputs

Use `wrangler secret put` so values are read interactively and do not enter shell
history. The account Worker owns:

- `TURNSTILE_SECRET`
- `GSV_TURNSTILE_SITE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `GSV_STRIPE_FOUNDING_PRICE_ID`
- `GSV_STRIPE_MERCHANT_MODE`, exactly `direct` or `managed_payments`

The managed Telegram Worker owns:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME` (the public bot identity, stored as an
  environment-owned input so no placeholder is committed)
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_CLAIM_SIGNING_KEY`, at least 32 random bytes

The inference Worker does not require a provider credential while
`MANAGED_INFERENCE_PROVIDER` is `disabled` and the source-controlled promotion
gate is closed. When provider approval is complete, add the provider secret to
the inference config and that Worker only in the same reviewed release batch.

No Stripe or Telegram credential is needed to build, typecheck, dry-run, or run
the local integration suites. They are required only before production
activation of their owning surfaces.

## Upload without exposing partial services

Run `npm run managed:check`, choose a unique release tag, then use
`wrangler versions upload` for every final config. Uploading creates versions
without applying the public triggers from those configs.

```bash
export GSV_MANAGED_RELEASE="managed-YYYYMMDD-HHMM"
```

Upload the account, inference, Telegram, Gateway, and ripgit configs from their
respective directories with:

```bash
npm exec --workspaces=false -- wrangler versions upload \
  --config <config> \
  --tag "${GSV_MANAGED_RELEASE}" \
  --minify
```

Deploy the tagged versions in this order: account, inference, Telegram, ripgit,
then Gateway. The placeholders make all binding targets valid; the order makes
the narrow runtime dependencies real before the Gateway can receive traffic.

```bash
npm exec --workspaces=false -- wrangler versions deploy \
  --config <config> \
  --version-tag "${GSV_MANAGED_RELEASE}" \
  --yes
```

Confirm internal RPC health and state migrations before attaching public
triggers. Apply the exact account and Telegram routes first, then the wildcard
Gateway route:

```bash
cd account-service
npm exec --workspaces=false -- wrangler triggers deploy --config wrangler.jsonc

cd ../adapters/telegram
npm exec --workspaces=false -- wrangler triggers deploy \
  --config wrangler.managed.jsonc

cd ../../gateway
npm exec --workspaces=false -- wrangler triggers deploy \
  --config wrangler.managed.jsonc
```

The account trigger deployment also installs its lifecycle cron. Inference and
ripgit have no public triggers.

Only after health checks pass should the Telegram bot webhook be registered as
`https://telegram.gsv.space/webhook` with the configured webhook verification
secret. Do not place the bot token or webhook secret directly in a recorded
command, ticket, log, or document.

## Activation checks

Before founding-cohort traffic, verify:

- `GET https://accounts.gsv.space/health` reports healthy;
- `GET https://accounts.gsv.space/` serves the no-store signup shell, and the
  public configuration names the intended managed Telegram bot without
  exposing any credential;
- `GET https://telegram.gsv.space/health` reports configured;
- an unknown installation hostname returns `404` and allocates no Kernel;
- an active test installation reaches only its persisted Kernel identity;
- account signup rejects missing or invalid Turnstile proof;
- no Checkout return grants entitlement without a verified webhook;
- a consumed inference attempt produces only a provider-neutral usage summary
  for its owning account and no summary for another principal;
- inference still returns the explicit provider-disabled state until approval;
- an unlinked Telegram DM cannot allocate a Process or inference budget;
- export and deletion still work for a restricted test installation; and
- logs contain opaque IDs and outcomes, not prompts, credentials, claims, or
  private content.

## Updates and rollback

For a compatible update, upload all changed target services first, then callers,
and move deployments only after the cross-service tests pass. Remove an old RPC
method only in a later release after no deployed caller uses it.

Record the prior version ID for every changed Worker. `wrangler rollback` can
restore Worker code and bindings, but it does not roll back D1, R2, or Durable
Object state. Schema changes therefore require forward-compatible code and a
forward repair migration. Do not detach routes as a first response to a model or
billing outage; the product must preserve login, cancellation, inspection,
export, billing repair, and deletion paths.

If a release affects account login, hostname routing, provisioning, Telegram
linking, or lifecycle state, repeat the clean multi-Worker flow before moving
founding-cohort traffic.
