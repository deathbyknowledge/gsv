# Deploy, update, and remove

## Hosted GSV

The hosting operator provisions and operates the Cloudflare resources for you. Finish
onboarding in the web application; you do not need Cloudflare credentials or a
local deployment tool.

## Run your own operator

The public stack serves one or many isolated spaces in your Cloudflare account.
It includes Accounts, Gateway, inference, storage and ripgit; no private H&M
service is required. Messenger adapters are disabled by default. Their
application credentials are operator configuration, and people link their own
identities after deployment.

Follow [Deploy GSV with Alchemy](./deploy-with-alchemy.md) for the complete flow:

1. Authenticate Alchemy and configure your Cloudflare account, `GSV_DOMAIN` and
   `GSV_ZONE_ID`.
2. Build, inspect the plan and deploy the `operator` stage.
3. Issue the one-time bootstrap link and create the first space through its
   setup invitation. Create further spaces explicitly in administration.

For an existing singleton deployment, use its original deployment composition
until an explicit migration is prepared. The root operator commands do not
adopt its state. Existing Wrangler users retain the
[standalone wrapper](./deploy-with-alchemy.md#existing-standalone-wrangler-deployments).

### Update

Pull the desired GSV revision, install its exact dependencies, inspect the
plan, and deploy the same `operator` stage with the same deployment inputs:

```bash
git pull --ff-only
npm ci
npm run deployment:plan
npm run deployment:deploy
```

Alchemy retains the stage state needed to update the existing resources rather
than creating a second operator environment. Existing Mail queues require the
[reader-before-writer upgrade](../../deployment/mail-queue-upgrade.md), and
adoption of a legacy combined Accounts database requires the one-time
[migration ownership handoff](../../deployment/installation-migration-adoption.md).
Routine updates of an already adopted public database use its migration ledger.

### Remove

Remove a space through the operator's deletion lifecycle, with its complete
resource inventory and owner receipts. The
[cleanup guide](./operate-gsv.md#connect-services-and-verify-cleanup) explains
configuration, retries and the separate reporting of live erasure and retained
copies. Deleting one space preserves other spaces in the deployment.

The Alchemy composition retains its physical resources. Full operator teardown
also requires accounting for shared Workers, databases, buckets, routes and
provider configuration after space cleanup; removing Alchemy state alone does
not erase them.

## Runtime notes

The operator stack uses Workers, D1, R2 and SQLite-backed Durable Objects. It
does not require Cloudflare Containers. Its default inference route uses the
operator's Workers AI account; spaces can also supply their own model
credentials. Provider execution runs in the inference Worker.

## See also

- [Alchemy deployment details](./deploy-with-alchemy.md)
- [Operator configuration](./operate-gsv.md)
- [Get Started](/get-started/)
- [Connect Devices](./connect-devices.md)
- [Connect a messenger](./messengers.md)
