# Deploy Ship with Alchemy

The public Alchemy stack deploys one operator environment into your Cloudflare
account. It serves isolated installations with public Accounts, Gateway and inference
Workers, R2 storage and ripgit. H&M services are optional. The root deployment
commands use the `operator` stage; they do not upgrade an existing singleton
deployment in place.

To try Ship without operating infrastructure, use [hosted Ship](https://gsv.space).
GitHub Releases provide the host applications and browser extension. Self-hosters
build the Workers and web UI from source; new releases do not include prebuilt
Cloudflare deployment archives.

## Deploy a new operator

### Public domains and operator links

The product is Ship; the GSV runtime and infrastructure identifiers stay stable.
`GSV_DOMAIN` chooses the domain for new installations. Configure public UI values
with `GSV_PUBLIC_CONFIG`, a JSON object containing optional `operatorName`,
`accountsOrigin`, `docsUrl`, `installUrl`, `termsUrl` and `privacyUrl`. URLs must use
HTTPS. The composition adds `primaryDomain` and `legacyDomains` from its routing
configuration. Custom compositions pass the same values as `GsvDeployment.presentation`.

For a domain transition, `GSV_DOMAIN_ALIASES='["old.example"]'` lets Accounts
materialize `handle.new.example` for an existing, recorded `handle.old.example`.
The alias points to the same installation, with its original canonical origin.
Public profiles redirect to that signed origin; profile lookup validates each
redirect and the final signature, so a new address finds the existing contact.
Unknown handles create no installation. New installations receive only the new
domain. Reset moves all active accepted hostnames together to the replacement
installation; retired aliases stay retired.

These settings do not move DNS or create routes in another zone. Preserve the
existing zone, routes and Worker resource identities in your operator composition,
and add the new zone's routes to the same Workers. Inspect the Alchemy plan before
changing a live domain. `GSV_OWNER_ORIGIN_ALIASES` accepts a JSON array of additional
HTTPS origins for owner signup and account access; administration remains at its
configured origin. Add each origin to an OIDC provider's callback allowlist if used.
Cookies remain local to each browser origin, so the new address may require login.
Custom compositions pass these as `GsvDeployment.installations.ownerOriginAliases`.
The composition validates the same HTTPS-origin rules as Accounts before creating
resources; paths, credentials and more than 16 aliases are rejected.

Gateway embeds the public configuration in the HTML, exposes it at
`/.well-known/gsv/deployment.json` on accepted installation hosts, and includes it
in `sys.connect` as `server.deployment`. It contains no credentials or authority.
Desktop release builds accept the same JSON through `VITE_GSV_PUBLIC_CONFIG`;
the release workflow reads the repository variable `GSV_PUBLIC_CONFIG`. After
connecting, clients use that server's settings. Without a configured primary
domain, users enter a full address. Documentation builds accept `GSV_DOCS_ORIGIN`
for the sitemap and `GSV_PRODUCT_URL` for the product link.

### Release briefs for existing Ships

Set `GSV_OPERATOR_UPDATES_FILE` to an operator-owned JSON file, or pass an
`operatorUpdates` catalog to `GsvDeployment`:

```json
{
  "publisher": { "id": "example-operator", "name": "Example Operator" },
  "updates": [{
    "id": "new-address-v1",
    "publishedAtMs": 1792051200000,
    "title": "Explain the new address",
    "brief": "Describe the change, what still works, and any action the owner needs."
  }]
}
```

The Gateway binding is `GSV_OPERATOR_UPDATES`. The catalog is limited to 32 briefs.
Keep publisher and update IDs stable, and use a fixed publication time rather
than the current deployment time. Changes to a previously delivered brief need a
new ID. Future briefs wait until an eligible reconciliation after publication.
New owners skip briefs published before their initial onboarding responsibility.

When an existing personal agent is next initialized or reconciled, Kernel creates
one ordinary `operator.update` responsibility per unseen brief. Resolved and
cancelled rows still deduplicate. No account scan or request to every Durable
Object is needed. Ship receives the ledger change through its normal context and
explains relevant updates in a suitable conversation, without waking solely to
announce them or changing user files. The owner can inspect or resolve the record
through the usual responsibility controls.

### Install the stack

Use a Cloudflare account and a domain in one of its DNS zones, plus Node.js 22 or
newer, npm and Rust for the source build. The composition includes CodeMode
and requires [Workers Paid](https://developers.cloudflare.com/dynamic-workers/pricing/).
Run these commands from the repository
root. Replace the account, domain and zone values with your own:

```bash
npm ci
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
export GSV_DOMAIN="example.com"
export GSV_ZONE_ID="your-zone-id"
npx alchemy login
npx alchemy cloudflare bootstrap
npm run deployment:plan
npm run deployment:deploy
```

Both deployment commands build the deployment manifest and Worker/web bundles
in `dist/cloudflare/` before invoking Alchemy. You can run `npm run deployment:build`
to produce these files without deploying. Keep the same Alchemy state, account,
resource names and `operator` stage for later updates. The default administration origin is
`https://accounts.<domain>`; Ship handles route under `<handle>.<domain>`.

The [operator configuration reference](./operate-gsv.md) lists optional inputs,
including `GSV_ADMIN_ORIGIN`, the Worker name prefix, Cloudflare Access and
inference limits. The default inference service uses the operator's Workers AI
account. People can also configure their own model credentials inside their Ship.

## Create the first Ship {#create-the-first-space}

Deployment prints `installationDatabase` and `administration`; it does not
create an installation or rotate credentials. Put the returned database ID in
`GSV_INSTALLATIONS_DATABASE_ID`. From a local controlling terminal, supply
`CLOUDFLARE_API_TOKEN` through your environment with access to that D1 database,
then issue the first-use link:

```sh
npm run deployment:bootstrap -- issue \
  --account "$CLOUDFLARE_ACCOUNT_ID" \
  --database "$GSV_INSTALLATIONS_DATABASE_ID" \
  --origin "https://accounts.$GSV_DOMAIN" --mode operator
```

Use the configured administration origin if you changed its default. Open the
one-time link printed to the terminal, create the first Ship and follow its
setup invitation. In the default `operator` access mode, save the operator
credential shown once by the page. It opens `/operator` for explicit creation
of further Ships. Cloudflare Access deployments use `--mode access` and their
configured policy instead. See [bootstrap and recovery](https://github.com/deathbyknowledge/gsv/blob/main/deployment/operator-bootstrap.md)
for link reissue and credential recovery. Keep credentials out of source files
and command arguments.

Owner email-code sign-in and **My Ships** are optional deployment configuration;
sign-in does not create Ships or grant operator access. Configure a verified sender
with `GSV_OWNER_EMAIL_FROM`, or the supported OIDC provider inputs, as described
in the [owner sign-in guide](https://github.com/deathbyknowledge/gsv/blob/main/deployment/operator-bootstrap.md#owner-email-sign-in).

## Enable adapters

No messenger adapters are enabled by default. Set `GSV_ADAPTERS` to a
comma-separated list of operator-supported adapter IDs after supplying each
adapter's deployment configuration. Its `adapter.json` declares the required
application secrets and variables in its single `deployment` manifest section.
For example, [Telegram's manifest](https://github.com/deathbyknowledge/gsv/blob/main/workers/adapters/telegram/adapter.json)
requires the bot token, webhook secret, bot username and public webhook origin.

The operator supplies application credentials through the deployment environment
and configures the public callback route and provider registration. Enabling a
Worker does not complete that provider setup. People then link their own
messenger identities from their Ship. See [operator adapter setup](./operate-gsv.md#connect-services-and-verify-cleanup).

## Update an existing deployment

Use the same operator configuration and state, install the desired revision's
dependencies, then run `deployment:plan` and `deployment:deploy` again. Preserve
physical resource identities. Operators adopting a legacy combined Accounts
database must first complete the one-time
[migration ownership handoff](https://github.com/deathbyknowledge/gsv/blob/main/deployment/installation-migration-adoption.md);
ordinary updates of an adopted public database use its migration ledger.
Deployments with an existing Mail queue also follow the
[reader-before-writer upgrade](https://github.com/deathbyknowledge/gsv/blob/main/deployment/mail-queue-upgrade.md).

The common stack does not adopt an old standalone deployment in place. Keep
that deployment on its preserved source or release until its data has been
exported and a new operator environment prepared. See the
[standalone retirement guide](./standalone-retirement.md).
