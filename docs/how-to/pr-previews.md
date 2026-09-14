# Pull request previews

GSV can deploy an isolated public stack for each pull request. Everyone reviewing
the change can open its preview, sign in with their company identity, create a
space and complete normal onboarding. The included model uses the operator's
Cloudflare Workers AI account; people do not need provider keys or model setup.

A preview contains Accounts, Gateway and the web UI, inference, ripgit, D1, R2
and their Durable Objects. It uses the PR's source and preserves its data across
pushes. Closing or merging the PR removes the preview's resources. Reopening a
PR after cleanup creates a fresh deployment.

This is an operator capability in the public deployment package. Commercial
services and production messenger credentials are not required. The first
version does not attach external messengers or automatically update a person's
native clients; those clients have their own build and release paths.

## Operator setup

Use a Cloudflare account dedicated to previews. The account needs Workers Paid,
Workers AI with the configured model available, an AI Gateway named `default`,
and an existing Alchemy HTTP state store using protocol version 5 (the version
used by the pinned Alchemy dependency). These shared services belong to the
operator and are never part of PR teardown.

Choose an active Cloudflare zone using full DNS setup and enable Advanced
Certificate Manager. Give this repository its own preview base domain. For a
base of `preview.example.com`, PR 314 uses:

| Purpose | Address |
| --- | --- |
| Administration and space creation | `accounts.pr-314.preview.example.com` |
| A space with handle `demo` | `demo.pr-314.preview.example.com` |

Each PR creates its own advanced certificate covering its nested names. A
certificate for `*.preview.example.com` alone does not cover those names. The
workflow waits for certificate issuance and HTTPS reachability before publishing
the link. It does not change the zone's nameservers or enable paid account
features automatically. See [Cloudflare's hostname coverage rules](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/).

Configure Cloudflare Access with a login method usable by your team, such as an
existing identity provider or email one-time PIN. Each PR gets an Access
application protecting its administration hostname and a policy limited to the
configured email addresses or domains. Accounts also validates the Access JWT.
Space login and the machine/WebSocket protocol use ordinary GSV authentication.
No operator tokens or onboarding capabilities are posted to GitHub.

Create the GitHub Actions environment **`gsv-previews`**. Allow deployments from
your trusted PR branches and `main`, which owns cleanup. Environment protection
rules can require a reviewer if that fits your contribution policy. Only
same-repository PRs targeting `main` deploy automatically; fork PRs do not receive
preview credentials. Review external contributions and bring the reviewed work
into a trusted repository branch before deploying it. Code in trusted PRs runs
with preview deployment credentials during the deployment step.

Set these environment variables:

| Variable | Value |
| --- | --- |
| `GSV_PREVIEW_ACCOUNT_ID` | Preview Cloudflare account ID |
| `GSV_PREVIEW_BASE_DOMAIN` | Dedicated base domain, such as `preview.example.com` |
| `GSV_PREVIEW_ZONE_ID` | Cloudflare zone ID |
| `GSV_PREVIEW_ZONE_NAME` | Zone apex, such as `example.com` |
| `GSV_PREVIEW_ACCESS_TEAM_DOMAIN` | `https://your-team.cloudflareaccess.com` |
| `GSV_PREVIEW_ACCESS_EMAIL_DOMAINS` | Comma-separated permitted company email domains |
| `GSV_PREVIEW_ACCESS_EMAILS` | Optional comma-separated exact addresses; at least one domain or address is required |
| `GSV_PREVIEW_INFERENCE_MODEL` | Optional Workers AI model ID; defaults to the public preview model |
| `GSV_PREVIEW_STATE_URL` | HTTPS origin of the existing Alchemy state store |

Set these environment secrets:

| Secret | Purpose |
| --- | --- |
| `GSV_PREVIEW_CLOUDFLARE_API_TOKEN` | Deploy and remove preview resources |
| `GSV_PREVIEW_STATE_TOKEN` | Authenticate to the preview Alchemy state store |
| `GSV_PREVIEW_R2_ACCESS_KEY_ID` | R2 S3 credentials for cleanup |
| `GSV_PREVIEW_R2_SECRET_ACCESS_KEY` | R2 S3 credentials for cleanup |

The Cloudflare token needs the account and zone permissions for Workers scripts,
Durable Objects, D1, R2, Workers AI/AI Gateway inspection, Access applications and
policies, DNS records, Workers routes, and certificate packs. Restrict it to the
preview account and zone. R2 S3 credentials must be able to list and remove
objects and abort incomplete multipart uploads in dynamically created preview
buckets. They are separate from the bearer token used by the Cloudflare API.

Finally, set **repository variable** `GSV_PREVIEWS_ENABLED=true`. Leave it unset
until setup is complete. Existing repository-wide production credentials are
never used as a fallback. Neither workflow runs cloud operations while disabled.

## What happens on a PR

1. The workflow verifies the PR is open, targets `main`, and belongs to this
   repository. It records the exact head commit.
2. A job without preview credentials builds the public stack and runs the local
   clean-instance onboarding and two-space lifecycle acceptance tests.
3. Deployment acquires a per-PR lock and rechecks the live head. It records the
   intended resource scope in the existing Alchemy state store before creating
   cloud resources. Resource names include the repository ID and PR number.
4. The public preview composition provisions the stack, Access policy and
   certificate. It creates no human account, sample conversations or completed
   onboarding state.
5. Once the certificate and HTTPS endpoint are ready, a sticky PR comment links
   to the administration page. Sign in, create your space and follow its setup
   link. Included inference has bounded request and output allowances.

Later pushes update the same deployment. Jobs recheck the current commit before
announcing readiness so an older queued build cannot claim to represent a newer
revision. The workflow also supports a manual run with a PR number and exact
head SHA. Existing CI remains independent of whether previews are enabled.

Cloud readiness checks confirm certificate issuance and endpoint reachability;
the first human conversation exercises live inference. Local automated tests
exercise onboarding and isolation in separate fresh test spaces. No test claims
to have verified live model output merely because a Worker uploaded successfully.

## Removal policy and recovery

`allowResourceDeletion` defaults to **false** in the public runtime, deployment
and adapter components. The normal deployment entry point exposes it as
`GSV_ALLOW_RESOURCE_DELETION`, also defaulting to `false`. Neither a CI
environment nor a stage name enables it implicitly. With the default, owned
Workers, data stores, DNS records and routes retain their removal policy.

The preview workflow explicitly supplies `GSV_ALLOW_RESOURCE_DELETION=true`.
That choice makes the preview's owned resources disposable; it does not grant
ownership of supplied services, the shared zone or the Alchemy state service.

On merge or close, a separate workflow uses **trusted `main` code**, never the
closed PR's code. It shares the deployment lock, rechecks that the PR is still
closed, fences the Workers, removes Durable Object classes, drains R2 objects
and incomplete multipart uploads, and removes D1, Workers, routes, preview DNS,
Access resources and the certificate. It verifies physical resource absence
before discarding the deployment's Alchemy state and cleanup record. Failed
cleanup keeps its record for retry. A scheduled sweep retries closed previews
every six hours; it can also be run manually.

Reopening before cleanup acquires the lock prevents that queued cleanup. Once
cleanup has started, it completes; reopening then recreates a fresh preview.
Do not store irreplaceable data in a disposable preview.

The cleanup record fixes the original account, zone and resource scope. Changing
repository variables cannot retarget an existing preview for deletion. Remove
old previews before moving their deployment to another domain/account. Shared
provider logs and platform backup retention follow their owning service's
retention rules; removing the live preview is not a claim of instantaneous
erasure from every retained platform copy.

This removes an entire isolated deployment. It is separate from deleting one
space while preserving other spaces in a shared GSV deployment.
