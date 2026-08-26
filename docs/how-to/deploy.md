# Deploy, update, and remove

## Managed GSV

Managed GSV provisions and operates the Cloudflare resources for you. Finish
onboarding in the web application; you do not need Cloudflare credentials or a
local deployment tool.

## Standalone GSV

The public Alchemy stack deploys a user-owned GSV into your Cloudflare account.
It discovers the adapter implementations bundled in the checkout from their
`adapter.json` files and defaults to installing all of them.

You need Node.js 22 or newer, npm, and a Cloudflare account:

```bash
git clone https://github.com/deathbyknowledge/gsv.git
cd gsv
npm ci
npx alchemy login
npx alchemy cloudflare bootstrap
npm run deployment:plan
npm run deployment:deploy
```

Open the Gateway URL printed by Alchemy to finish onboarding. Select a subset
of adapters without changing source:

```bash
GSV_ADAPTERS=telegram,discord npm run deployment:plan
GSV_ADAPTERS=telegram,discord npm run deployment:deploy
```

Adapter credentials are configured in GSV after deployment. They are not
stored in the public stack source.

### Update

Pull the desired GSV revision, install its exact dependencies, inspect the
plan, and deploy the same `standalone` stage:

```bash
git pull --ff-only
npm ci
npm run deployment:plan
npm run deployment:deploy
```

Alchemy retains the stage state needed to update the existing resources rather
than creating a second GSV.

### Remove

The public stack currently marks deployed resources for retention so an
accidental stack-state operation cannot erase user data. For now, perform full
teardown from the Cloudflare dashboard after reviewing the Workers, Durable
Objects, and R2 bucket owned by the `standalone` stage. Do not delete R2 or
Durable Object state until confirming it is no longer needed. Guided standalone
teardown will move into the web deployer after the new deployment path has been
dogfooded.

## Runtime notes

The standalone baseline uses Workers, R2, and SQLite-backed Durable Objects. It
does not require Cloudflare Containers. Workers Paid adds more capacity and
enables features that depend on paid bindings.

WhatsApp maintains an outbound provider connection. A continuously resident
account can consume most of the current Workers Free Durable Object duration
allowance, so treat one account as the Free-plan baseline and review current
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
before operating several always-connected accounts.

## See also

- [Standalone Alchemy details](./deploy-with-alchemy.md)
- [Get Started](/get-started/)
- [Connect Devices](./connect-devices.md)
- [Connect a messenger](./messengers.md)
