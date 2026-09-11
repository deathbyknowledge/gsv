# Run GSV for your people

One operator deployment serves multiple isolated installations. The public
composition includes the installation directory, administration, Gateway,
storage, ripgit and inference execution. Each installation keeps its own Kernel,
accounts, credentials, processes and data. H&M funding or billing services are
optional operator integrations.

The reference composition is [`alchemy.run.ts`](../../alchemy.run.ts). Configure
Alchemy's Cloudflare account/authentication and set these deployment inputs:

| Input | Purpose |
| --- | --- |
| `GSV_DOMAIN` | Base domain for installation hostnames. |
| `GSV_ZONE_ID` | Cloudflare DNS zone containing that domain. |
| `GSV_ADMIN_ORIGIN` | Administration origin; defaults to `https://accounts.<domain>`. |
| `GSV_WORKER_PREFIX` | Physical resource name prefix; defaults to `gsv`. |
| `GSV_ACCESS_MODE` | `operator` or `access`; defaults to `operator`. |
| `GSV_ACCESS_TEAM_DOMAIN`, `GSV_ACCESS_AUDIENCE` | Required for Cloudflare Access mode. |
| `GSV_OWNER_OIDC_ISSUER`, `GSV_OWNER_OIDC_CLIENT_ID`, `GSV_OWNER_OIDC_CLIENT_SECRET` | Optional owner identity provider for account linking and root recovery; issuer and client ID must be supplied together. |
| `GSV_ADAPTERS` | Comma-separated operator-enabled adapter IDs; empty by default. |
| `GSV_INFERENCE_PROVIDER`, `GSV_INFERENCE_MODEL` | Operator default provider and model. |
| `GSV_INFERENCE_API_KEY`, `GSV_INFERENCE_BASE_URL` | Optional operator provider credentials and endpoint. |

Optional inference ceilings are `GSV_INFERENCE_MONTHLY_REQUESTS`,
`GSV_INFERENCE_MONTHLY_OUTPUT_TOKENS`, `GSV_INFERENCE_MAX_OUTPUT_TOKENS` and
`GSV_INFERENCE_MAX_DURATION_MS`. The default Workers AI route uses the operator's
Cloudflare account. Installations can also configure their own model credentials;
provider execution uses the same public service either way.

Build and review the deployment before applying it:

```sh
npm run deployment:build
npx alchemy plan --stage operator
npx alchemy deploy --stage operator --yes
```

The release manifest is version 2 and includes the installation directory Worker,
its public migrations and the inference Worker alongside Gateway, web assets,
ripgit and adapter bundles. A version 1 singleton bundle is not accepted by this
composition. Existing singleton deployments require an explicit migration before
upgrading; existing multi-installation operators must preserve their physical
resource identities and complete the directory migration ownership handoff.

After the first successful apply, use the deployment's directory database ID and
administration origin with the [bootstrap command](../../deployment/operator-bootstrap.md).
It prints a one-time link only to your local controlling terminal. The link
creates the first installation and its setup invitation. Further installations
are created explicitly in administration. Ordinary redeployments do not create
installations or rotate credentials.

Enabled adapters require their application secrets declared in the adapter
manifest, along with its `requiredVariables`. Telegram needs its bot username
and public webhook origin, Slack its public origin, and Discord its application
ID. The common runtime binds Accounts, Gateway and each adapter's lifecycle
service; the manifest inventories every owned Durable Object namespace,
including retained legacy namespaces. Their public callback routes and provider application registration
belong to the operator; enabling a Worker alone does not complete that external
provider setup. People pair their own identities through their installation.

For local development, `npm run dev` builds the SDK and web assets, applies public
migrations to a separate local database and runs the four public Workers. Open
`http://localhost:8976/admin`, create an installation and follow its setup link at
`http://<handle>.localhost:8976`. No private repository is required. The local
administration bypass admits only the configured localhost origin. The default
state directory is `.wrangler/operator-dev-state`; set `GSV_DEV_STATE_DIR` to use
another disposable directory. Model calls still require an available provider.

This composition and the migration tooling have local D1 and configuration tests.
A fresh Cloudflare account with two installations and H&M's adopted staging
deployment remain separate acceptance gates; local success is not evidence that
those cloud deployments have completed.
