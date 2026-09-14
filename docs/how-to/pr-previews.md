# Pull request previews

Each PR gets the public GSV stack: Accounts, Gateway and web UI, inference,
ripgit, D1, R2 and Durable Objects. Open its PR comment link, sign in through
Cloudflare Access, create a space and complete normal onboarding. Included
inference uses the operator's Workers AI account; no model keys are needed.
External messengers and native client releases are separate.

[`preview.alchemy.ts`](../../preview.alchemy.ts) composes the existing public
components. [GitHub Actions](../../.github/workflows/preview.yml) builds the PR
and runs `alchemy deploy`; pushes update that same stack. Closing or merging
runs `alchemy destroy` from `main`. Cleanup uses `pull_request_target: closed`
so closing a PR with merge conflicts also triggers it. Alchemy owns state,
dependencies and deletion.
There is no separate preview registry or cleanup controller.

## Operator setup

Choose a preview Cloudflare account with Workers Paid, Workers AI and an AI
Gateway named `default`. Configure Alchemy's standard Cloudflare state store
with `npx alchemy bootstrap cloudflare` using that account's credentials. The
shared state store stays outside individual preview stacks.

Choose a dedicated base domain in an active full-setup Cloudflare zone with
Advanced Certificate Manager enabled. For `preview.example.com`, PR 314 uses
`accounts.pr-314.preview.example.com` for administration and
`demo.pr-314.preview.example.com` for a space named `demo`. The stack orders a
certificate for each PR's nested names; initial issuance is asynchronous.
A wildcard for `*.preview.example.com` alone cannot cover these names.
See [Cloudflare's hostname coverage rules](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/).

Configure a Cloudflare Access login method for your team, such as email PIN or
an existing identity provider. Each preview gets an administration application
and an allowlist policy. Accounts verifies its Access JWT. Space login and
machine connections use ordinary GSV authentication.

Create a GitHub Actions environment named **`gsv-previews`**, permitting your
trusted PR branches and `main`. Set these environment variables:

| Variable | Value |
| --- | --- |
| `GSV_PREVIEW_ACCOUNT_ID` | Cloudflare account ID |
| `GSV_PREVIEW_BASE_DOMAIN` | Dedicated base, such as `preview.example.com` |
| `GSV_PREVIEW_ZONE_ID` | Cloudflare zone ID |
| `GSV_PREVIEW_ZONE_NAME` | Zone apex, such as `example.com` |
| `GSV_PREVIEW_ACCESS_TEAM_DOMAIN` | `https://your-team.cloudflareaccess.com` |
| `GSV_PREVIEW_ACCESS_EMAIL_DOMAINS` | Comma-separated allowed email domains |
| `GSV_PREVIEW_ACCESS_EMAILS` | Optional comma-separated exact addresses; one domain or address is required |
| `GSV_PREVIEW_INFERENCE_MODEL` | Optional Workers AI model; defaults to `@cf/zai-org/glm-5.3-flash` |

Set environment secret **`GSV_PREVIEW_CLOUDFLARE_API_TOKEN`** for the chosen
account and zone, with permissions for Workers, D1, R2, Workers AI, Access
applications/policies, DNS, routes, certificates and Alchemy's Secrets Store.
Alchemy derives its state credentials through its native Cloudflare provider.
No separate state token or R2 S3 credentials are needed.

Finally, set repository variable **`GSV_PREVIEWS_ENABLED=true`**. Until then the
workflow is disabled. Only same-repository PRs targeting `main` are eligible;
fork PRs receive no preview credentials. Trusted PR infrastructure runs with
the preview token when Alchemy applies it. Review external contributions before
bringing them into a trusted branch.

## Lifecycle and deletion

Jobs serialize per PR and recheck its current state and revision after taking
the lock. Builds run before the step that receives the Cloudflare token.
Successful deploys publish a PR link; successful teardown marks it removed.
Reopening after deletion creates a fresh preview. Existing CI checks remain
independent of whether previews are enabled.

`allowResourceDeletion` defaults to **false** in the public components and
`GSV_ALLOW_RESOURCE_DELETION` defaults to **false** in both entrypoints. CI
explicitly sets it to `true` for previews. This covers owned Workers, data stores,
DNS, routes, Access resources and certificates; it does not remove the shared
zone, state store or externally supplied services.

Alchemy force-deletes Workers and their Durable Objects, empties R2 and removes
D1 and the other stack resources. Failed destruction fails the job; rerun it to
resume native cleanup. Disposable buckets expire unfinished multipart uploads
after one day. If an unfinished upload prevents bucket deletion, retry after
that asynchronous expiry. See [Worker deletion](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/delete/)
and [R2 lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

Remove existing previews before changing the configured account, domain or zone.
Keep this configuration available for close jobs and retries. Whole-preview
teardown is separate from deleting one space in a shared deployment; platform
backup and log retention remain governed by Cloudflare.
