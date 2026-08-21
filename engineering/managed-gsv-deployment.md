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
| Managed email | `gsv-managed-email` | Email Routing and outbound Queue consumer | MailInstallation DOs |

Accounts has no dependency on another managed Worker. Inference exports usage
to Accounts. The Gateway binds Accounts, Inference, ripgit, and the managed
outbound-mail Queue. Email is deployed last because it binds Accounts,
Inference, the Gateway, Cloudflare Email Sending, and consumes that Queue.
Inference, ripgit, and email disable `workers.dev` and Worker preview URLs and
have no public HTTP routes.

Managed email accepts `<installation-handle>@gsv.space`. Accounts resolves the
handle to an active immutable installation before the email Worker addresses a
MailInstallation Durable Object. The adapter durably queues exact RFC 822 bytes
and summary work; the Kernel remains the canonical mailbox owner and stores the
message under the selected local user's home. Version one assigns one address
to the installation's first unlocked human account. Per-user aliases require a
future address directory rather than overloading installation routing.

Outbound mail uses the same installation address and is managed-only. The
Kernel persists a canonical text-only, single-recipient intent in SQLite and
its body in R2. The v1 text cap is 1 MiB, leaving headroom beneath Cloudflare's
5 MiB composed-message limit for encoding and headers. The Kernel publishes
only the installation ID, opaque outbound ID, and content fingerprint to the
Queue. The email Worker durably admits that trusted reference to the
installation-scoped Durable Object before acknowledging the Queue message. The
DO re-resolves the active installation through Accounts, persists the expected
sender on its first successful resolution, claims the draft from the Gateway,
reserves daily message and byte quotas, records the provider attempt, and calls
the native Email Sending binding once. Completion is
`accepted`, `failed`, or `unknown`; `unknown` is an at-most-once terminal result
and is never replayed after provider ambiguity.

The production Gateway uses `gateway/src/index.ts`. The
`gateway/src/managed-development.ts` wrapper exists only to put the local
Accounts admin and wildcard installations behind one development port.

The Accounts operator surface is server-rendered and split by responsibility:

- `/admin/installations` lists bounded, searchable installation summaries;
- `/admin/installations/new` owns reservation and creation;
- `/admin/installations/<installationId>` owns one installation's lifecycle,
  provisioning, reset, inference policy, and current-period usage;
- `/admin/inference` owns the platform-wide inference switch and aggregate
  usage.

HTML mutations return to their owning page. Creation and onboarding-link
reissue render their one-time capability directly because it must not be
persisted or placed in a redirect URL. The private `/admin/api/*` routes mirror
the same list, detail, and policy boundaries.

Reset is the staging-safe path for replacing incompatible installation state.
The operator types the current handle, Accounts atomically gives that hostname
to a fresh installation ID, carries its inference allowance forward, and
issues the normal one-time onboarding capability. The prior installation
becomes `retained`; it is hidden from the primary registry but remains
addressable by its immutable ID so old work fails closed and later cleanup has
an exact target. `installation_reset_operations.data_deletion_state` begins at
`pending`. Reset must never be described as deleting the user's stored data.

Full deletion remains a separate release gate. Its coordinator must be
resumable and must record confirmation from every state owner before changing a
reset operation to `complete`: Accounts D1 metadata and usage, the Kernel and
all Process Durable Objects, installation-scoped R2 objects, ripgit
repositories, inference Durable Objects and unsettled usage, email Durable
Objects and queued references, and managed-adapter routes and identity links.
Ingress is disabled before cleanup begins; retries are idempotent; an export or
retention window, when offered, precedes irreversible deletion. Until that
coordinator ships, the admin detail deliberately exposes old data deletion as
`pending` rather than making a false erasure claim.

Standalone `gateway/wrangler.jsonc`, `ripgit/wrangler.toml`, `gsv infra
deploy`, and `scripts/build-cloudflare-bundles.sh` remain independent. They do
not create these Workers, bind their services, or require platform credentials.

## Before the first deployment

The wildcard DNS record for `*.gsv.space` must be proxied through Cloudflare.
The checked Gateway route attaches that wildcard to `gsv-managed-gateway`.

Email Routing activation is an explicit operator step. Do not install an apex
catch-all during a normal Worker deployment: a catch-all can take over existing
`@gsv.space` mail. Inspect the zone's current Email Routing rules, then add only
the reviewed address or catch-all rule that should deliver to
`gsv-managed-email`. Staging uses the separate `staging.gsv.space` email
subdomain and `gsv-staging-email`; its first dogfood route must be the literal
address for the disposable installation, not a catch-all.

Cloudflare Email Sending is a separate domain onboarding from Email Routing.
Before enabling outbound mail, verify that the exact production or staging mail
domain is onboarded for Email Sending and that its SPF, DKIM, DMARC, and bounce
records are healthy. Arbitrary recipients require Workers Paid. New sending
domains enable Email preview by default, which stores sent message content in
Cloudflare's activity log temporarily; turn preview off before using real GSV
mail. Confirm the account's current daily sending quota because production and
staging share that account-level limit.

The source-controlled deployment is intentionally inert: it sets
`MAIL_OUTBOUND_ENABLED` to false and both outbound daily allowances to zero.
For the first staging dogfood, configure the Email binding with the exact
staging installation sender and a single verified test destination. Do not use
a wildcard sender restriction: Cloudflare's binding restriction accepts exact
addresses. Keep production disabled while staging is exercised. Activating an
environment requires one reviewed change that sets the switch, nonzero daily
message and byte allowances, and the intended binding restrictions together.

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

The validation command builds the protocol and desktop, typechecks the managed
TypeScript Workers, runs the email adapter tests, generates bindings from every
production config, and runs Wrangler dry-run builds for all five Workers:

```bash
npm run managed:check
```

Deploy with an optional release label:

```bash
export GSV_MANAGED_RELEASE_REF=managed-YYYYMMDD-HHMM
npm run managed:deploy -- --confirm
```

The command applies pending Accounts D1 migrations before deploying Accounts,
then deploys Inference, ripgit, the wildcard Gateway, and email. Durable Object
class migrations are applied with their owning Worker deployments. The central
Humans & Machines infrastructure repository manages the equivalent production
and staging graph; use one deployment owner for a live environment rather than
mixing it with this direct Wrangler path.

Managed inference is source-controlled on in `inference/wrangler.jsonc`. The
zero deployment ceiling adds no second ceiling; Accounts remains the runtime
control plane through its global switch and each installation's positive
allowance. A positive deployment ceiling may be added as an additional hard
cap, in which case the effective allowance is the lower of the deployment and
installation limits.

The Access-protected `/admin/inference` page owns the private route behind the
public `gsv/default` model. Operators can change the OpenRouter model, provider
allow/deny/order lists, quantizations, privacy requirements, provider sorting,
and the prices used for allowance accounting without exposing those choices to
installations. Migration `0007_managed_inference_routing.sql` preserves the
previous model and fallback behavior as its initial route. Apply Accounts D1
migrations before deploying an Inference Worker that expects the routing field,
and keep the OpenRouter credential solely in the Inference Worker secret.

Managed outbound email follows the same fail-closed release discipline. Queue
and Email Sending bindings may be deployed while its boolean and daily quotas
remain zero. Provision `gsv-managed-mail-outbound` and its
`gsv-managed-mail-outbound-dead-letter` Queue before either producer or
consumer deployment. Alert on the dead-letter Queue and replay a reference only
after the admission failure is understood; the Kernel and installation ledger
make an exact replay idempotent.

Keep both Queues at the 14-day retention used by the direct deployment script,
and do not attach the normal email consumer to the dead-letter Queue. To
redrive a valid entry, first fix the admission failure, then publish the exact
unchanged JSON body to `gsv-managed-mail-outbound`. Wait until `mail status`
or the installation delivery ledger shows durable progress or a terminal
outcome before acknowledging the dead-letter copy. A malformed or unsupported
entry is poison and must be acknowledged without replay; never repair an
installation ID, outbound ID, or fingerprint by hand.

Email Routing domains, routing rules, Email Sending domains, preview settings,
and exact sender/destination restrictions remain operator-owned Cloudflare
configuration; the application deployment must not silently claim them.

## Smoke and rollback

After deployment:

- verify an authenticated operator can open `https://gsv.space/admin`;
- verify an unauthenticated request is denied;
- verify a random wildcard hostname returns `404` without creating a Kernel;
- create a disposable installation, complete onboarding, and log in;
- reset that disposable installation, verify its hostname selects a new
  installation ID, verify the old ID resolves only as `retained`, and complete
  onboarding again from the newly issued capability;
- verify its R2, Process, repository, and inference addresses use its immutable
  installation ID; and
- send mail to the reviewed disposable address, then verify `mail list`,
  `mail show <messageId>`, `mail show <messageId> --raw`, and the reduced event
  reaches Personal without exposing mailbox metadata or raw message content;
- from that installation, send one text message with `mail send` to the exact
  verified test recipient, replay it with the same delivery ID, and verify only
  one provider message exists and the durable state settles to `accepted`;
- reply with `mail reply <messageId>` and verify the sender remains the exact
  Accounts-derived installation address and threading headers refer to the
  stored inbound message;
- inspect the email Worker ledger and account Email Sending activity, then
  restore outbound to disabled with zero daily quotas before widening either
  the inbound route or recipient policy; and
- disable the Accounts operational switch and verify generation fails without
  contacting the provider; then enable the operational and installation
  controls and verify a generation settles into the Accounts usage view.

Record each prior Worker version before updating. Worker rollback does not roll
back D1, R2, or Durable Object storage. Schema changes therefore remain
forward-only and require a new repair migration rather than editing a migration
that has shipped.
