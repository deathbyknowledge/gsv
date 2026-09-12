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
| `GSV_OWNER_EMAIL_FROM` | Verified sending address for native email-code owner sign-in, My spaces and recovery. |
| `GSV_OWNER_EMAIL_ALLOWED_RECIPIENTS` | Optional comma-separated recipient restriction for owner verification mail, useful on staging. |
| `GSV_OWNER_OIDC_ISSUER`, `GSV_OWNER_OIDC_CLIENT_ID`, `GSV_OWNER_OIDC_CLIENT_SECRET` | Optional owner identity provider for account linking and root recovery; issuer and client ID must be supplied together. |
| `GSV_ADAPTERS` | Comma-separated operator-enabled adapter IDs; empty by default. |
| `GSV_INFERENCE_PROVIDER`, `GSV_INFERENCE_MODEL` | Operator default provider and model. |
| `GSV_INFERENCE_API_KEY`, `GSV_INFERENCE_BASE_URL` | Optional operator provider credentials and endpoint. |
| `GSV_DELETION_CATALOG_FILE` | Path to a JSON array declaring current and historical external resources for deletion; see the workflow below. |

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
administration origin with the [bootstrap command](https://github.com/deathbyknowledge/gsv/blob/main/deployment/operator-bootstrap.md).
It prints a one-time link only to your local controlling terminal. The link
creates the first installation and its setup invitation. Further installations
are created explicitly in administration. Ordinary redeployments do not create
installations or rotate credentials.

## Give someone a space

Operator administration and owner sign-in have separate jobs. In `operator`
access mode, open `<admin-origin>/operator` and sign in with the operator
credential saved during bootstrap. In `access` mode, open
`<admin-origin>/admin` through the configured Cloudflare Access policy.
Choose **New space**, reserve its handle, and give the person the resulting
one-time setup link. They use that link to create their local account and
root password. Further spaces use this same administration flow.

With native owner email enabled, `<admin-origin>/owner/login` verifies the
person's email and opens **My spaces**. Signing in there does not create a
space or grant operator administration. To add an existing space to that
list, sign in to the space as **root**, open **Settings → sign-in → Space
ownership → link owner identity**, and verify the email again. This binds
current root authorization to the verified owner; onboarding does not yet
perform that link automatically. The owner can then see the space in My
spaces and start root recovery there if needed.

The sending address must be enabled with the provider and its DNS records
verified before codes can be delivered. The public deployment creates and
preserves the owner-authentication secret. Keep the deployment state on
redeploy so existing verification and session records remain usable. Owner
verification mail is independent of a space's messaging adapters.

## Connect services and verify cleanup

Enabled adapters require their application secrets declared in the adapter
manifest, along with its `requiredVariables`. Telegram needs its bot username
and public webhook origin, Slack its public origin, and Discord its application
ID. The common runtime binds Accounts, Gateway and each adapter's lifecycle
service; the manifest inventories every owned Durable Object namespace,
including retained legacy namespaces. Their public callback routes and provider application registration
belong to the operator; enabling a Worker alone does not complete that external
provider setup. People pair their own identities through their installation.

Before deleting a space, account for every service that still holds its data,
including services previously enabled. `GSV_DELETION_CATALOG_FILE` supplies the
external-resource catalog to the public composition. Each entry declares an
`id`, physical `namespace`, `kind`, `source`, `scope` (`installation` or
`deployment`), and `disposition` (`live` or `retained`). Include logs, telemetry
exports, provider copies, caches, backups, unfinished R2 uploads, and mail queues
and dead-letter queues where applicable. Queues and unfinished uploads are live
resources. Current bindings and default-provider settings cannot establish the
complete history of destinations, including people's own provider accounts.
Leave the catalog unset while that inventory is unresolved; deletion admission
fails closed. A configured catalog declares scope, not successful cleanup.

Follow the inventory and evidence workflow:

1. Inventory application owners and historical addresses using the
   [historical inventory rules](https://github.com/deathbyknowledge/gsv/blob/main/engineering/installation-deletion-gateway.md#historical-inventory-is-a-prerequisite).
   The [Durable Object capture command](https://github.com/deathbyknowledge/gsv/blob/main/deployment/installation-deletion-capture.md)
   records namespace snapshots and trusted ownership observations for an already
   retired space. Its capture alone neither begins erasure nor proves the
   complete inventory.
2. Combine those captures with the external scopes and evidence required by the
   [operator evidence contract](https://github.com/deathbyknowledge/gsv/blob/main/engineering/installation-deletion-operator.md).
   Accounts verifies the inventory before cleanup starts. Provider API access
   stays in the operator's tools; record fresh cleanup evidence after the
   application owners' live-erasure receipts, using the existing operator
   authentication and mutation Origin checks.
3. Inspect `GET /admin/api/installations/{installationId}/deletion` for owner
   progress and `/deletion/operator-resources` under the same installation path
   for external evidence. Resume failed work through the authenticated retry
   endpoint. Preserve the replacement space, other people's data, and shared
   application credentials throughout cleanup.

Report verified live-data erasure separately from retained copies. Known,
enforced retention can remain pending with its declared expiry visible; the
operation must not claim final erasure until every live scope is empty and every
retained copy is deleted or expires. Unknown scope or expiry stays unresolved.
New inference tags can identify new AI Gateway records, but cannot establish
ownership or absence of historical untagged logs in a shared gateway.

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
