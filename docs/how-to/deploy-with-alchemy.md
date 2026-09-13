# Deploy GSV with Alchemy

The public Alchemy stack deploys one operator environment into your Cloudflare
account. It serves isolated spaces with public Accounts, Gateway and inference
Workers, R2 storage and ripgit. H&M services are optional. The root deployment
commands use the `operator` stage; they do not upgrade an existing singleton
deployment in place.

## Deploy a new operator

Use a Cloudflare account and a domain in one of its DNS zones, plus Node.js 22 or
newer, npm and Rust for the source build. Run these commands from the repository
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

Both deployment commands build the release manifest and Worker/web bundles
before invoking Alchemy. Keep the same Alchemy state, account, resource names and
`operator` stage for later updates. The default administration origin is
`https://accounts.<domain>`; space handles route under `<handle>.<domain>`.

The [operator configuration reference](./operate-gsv.md) lists optional inputs,
including `GSV_ADMIN_ORIGIN`, the Worker name prefix, Cloudflare Access and
inference limits. The default inference service uses the operator's Workers AI
account. People can also configure their own model credentials inside a space.

## Create the first space

Deployment prints `installationDatabase` and `administration`; it does not
create a space or rotate credentials. Put the returned database ID in
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
one-time link printed to the terminal, create the first space and follow its
setup invitation. In the default `operator` access mode, save the operator
credential shown once by the page. It opens `/operator` for explicit creation
of further spaces. Cloudflare Access deployments use `--mode access` and their
configured policy instead. See [bootstrap and recovery](../../deployment/operator-bootstrap.md)
for link reissue and credential recovery. Keep credentials out of source files
and command arguments.

Owner email-code sign-in and **My spaces** are optional deployment configuration;
they do not create spaces or grant operator access. Configure a verified sender
with `GSV_OWNER_EMAIL_FROM`, or the supported OIDC provider inputs, as described
in the [owner sign-in guide](../../deployment/operator-bootstrap.md#owner-email-sign-in).

## Enable adapters

No messenger adapters are enabled by default. Set `GSV_ADAPTERS` to a
comma-separated list of operator-supported adapter IDs after supplying each
adapter's deployment configuration. Its `adapter.json` declares the required
application secrets and variables in the current `managed` manifest section.
For example, [Telegram's manifest](../../workers/adapters/telegram/adapter.json)
requires the bot token, webhook secret, bot username and public webhook origin.

The operator supplies application credentials through the deployment environment
and configures the public callback route and provider registration. Enabling a
Worker does not complete that provider setup. People then link their own
messenger identities from their space. See [operator adapter setup](./operate-gsv.md#connect-services-and-verify-cleanup).

## Update an existing deployment

Use the same operator configuration and state, install the desired revision's
dependencies, then run `deployment:plan` and `deployment:deploy` again. Preserve
physical resource identities. Operators adopting a legacy combined Accounts
database must first complete the one-time
[migration ownership handoff](../../deployment/installation-migration-adoption.md);
ordinary updates of an adopted public database use its migration ledger.
Deployments with an existing Mail queue also follow the
[reader-before-writer upgrade](../../deployment/mail-queue-upgrade.md).

The root operator commands do not adopt an existing `standalone` Alchemy stage.
Keep that deployment's original composition and state until an explicit
migration is prepared. The separate Wrangler compatibility path below remains
available for existing Wrangler deployments.

## Existing standalone Wrangler deployments

The Gateway package's `dev` and `start` commands run both the Gateway and its
standalone inference companion. The `deploy` command deploys the companion first,
then the Gateway. Both retain the existing `singleton` identity and storage names;
the companion owns the native Workers AI binding.

```bash
GSV_GATEWAY_ORIGIN=https://your-existing-gsv.example.com npm run deploy --workspace gateway
```

Set the exact existing Gateway HTTPS origin, without a trailing slash. The
companion's directory uses that origin and admits only `singleton`; it has no
public endpoint. Use these package commands instead of deploying the Gateway
alone with raw Wrangler. Custom Worker names or environments belong in an
explicit deployment composition, which must wire both Workers together.
