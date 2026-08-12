# Managed GSV deployment

This is the private production topology operated by Humans & Machines, Inc. It
is not part of standalone GSV deployment or its public Cloudflare release
bundles.

## Topology

| Component | Worker | Public route | State |
|---|---|---|---|
| Operator directory | `gsv-accounts` | `gsv.space/admin*` | D1 `gsv-accounts` |
| Managed inference | `gsv-inference` | none | InferenceInstallation DOs |
| Managed repositories | `gsv-managed-ripgit` | none | Repository DOs |
| Installation Gateway | `gsv-managed-gateway` | `*.gsv.space/*` | Kernel and Process DOs, R2 `gsv-managed-storage` |

The graph is deployed in that order. Accounts has no dependency on another
managed Worker. Inference exports usage to Accounts, and the Gateway is deployed
last because it binds all three internal services. Inference and ripgit disable
`workers.dev` and preview URLs and have no public routes.

The production Gateway uses `gateway/src/index.ts`. The
`gateway/src/managed-development.ts` wrapper exists only to put the local
Accounts admin and wildcard installations behind one development port.

Standalone `gateway/wrangler.jsonc`, `ripgit/wrangler.toml`, `gsv infra
deploy`, and `scripts/build-cloudflare-bundles.sh` remain independent. They do
not create these Workers, bind their services, or require platform credentials.

## Before the first deployment

The wildcard DNS record for `*.gsv.space` must be proxied through Cloudflare.
The checked Gateway route attaches that wildcard to `gsv-managed-gateway`.

Create a Cloudflare Access self-hosted application protecting
`https://gsv.space/admin*`. Configure the Accounts Worker with both required
values:

- `GSV_ADMIN_ACCESS_TEAM_DOMAIN`
- `GSV_ADMIN_ACCESS_AUD`

Configure `OPENROUTER_API_KEY` only on `gsv-inference`. Required secret names
are declared in the Worker configs, but values must be added through encrypted
Worker secrets. Never place them in this repository or a recorded command.

For a first deployment, the deployment script accepts secret files stored
outside the repository:

```bash
export GSV_MANAGED_ACCOUNTS_SECRETS_FILE=/secure/path/accounts.json
export GSV_MANAGED_INFERENCE_SECRETS_FILE=/secure/path/inference.json
```

Wrangler preserves already-configured secrets on later deploys, so those inputs
can be omitted after bootstrap. The Accounts D1 database and managed R2 bucket
must exist in the target Cloudflare account or be accepted when Wrangler offers
to provision the checked resource names.

## Validate and deploy

The validation command builds the protocol and desktop, typechecks all three
TypeScript Workers, generates bindings from every production config, and runs
Wrangler dry-run builds for all four Workers:

```bash
npm run managed:check
```

Deploy with an optional release label:

```bash
export GSV_MANAGED_RELEASE_REF=managed-YYYYMMDD-HHMM
npm run managed:deploy -- --confirm
```

The command applies pending Accounts D1 migrations before deploying Accounts,
then deploys Inference, ripgit, and the wildcard Gateway. Durable Object class
migrations are applied with their owning Worker deployments.

Managed inference is source-controlled off in `inference/wrangler.jsonc`, with
a zero deployment ceiling. Do not enable it by changing only the boolean:
choose and review a nonzero deployment ceiling in the same change, deploy
Inference, then use the Accounts admin to enable the operational switch and a
positive allowance for each installation. The effective allowance is the lower
of the deployment ceiling and the installation allowance.

## Smoke and rollback

After deployment:

- verify an authenticated operator can open `https://gsv.space/admin`;
- verify an unauthenticated request is denied;
- verify a random wildcard hostname returns `404` without creating a Kernel;
- create a disposable installation, complete onboarding, and log in;
- verify its R2, Process, repository, and inference addresses use its immutable
  installation ID; and
- while inference is disabled, verify generation fails without contacting the
  provider; then enable the operational and installation controls and verify a
  generation settles into the Accounts usage view.

Record each prior Worker version before updating. Worker rollback does not roll
back D1, R2, or Durable Object storage. Schema changes therefore remain
forward-only and require a new repair migration rather than editing a migration
that has shipped.
