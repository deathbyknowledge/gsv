# Product emails and essential service notices

Accounts owns product-email permission for both Ship signup and the public
website. The website is a stateless form proxy. Kernel accounts, People
invitations, Terms acceptance, email verification and service-notice recipients
are not marketing lists. Existing owners and legacy website rows remain opted
out unless they make a new explicit choice. There is no import or campaign API
in this implementation.

## Consent and delivery

The separate signup checkbox starts unchecked. Its wording version is
`ship-product-updates-2026-10-23`; the supported locales are English, Spanish and
Brazilian Portuguese. The API records the challenge's address, the server time,
source, wording version and locale before activation. Successful verification
associates that intent with the principal and verification receipt. Verification
without that intent creates no marketing permission. Settings use the verified
owner session and a compare-and-swap consent revision. An old tab cannot undo a
newer choice. Terms acceptance stays separate.

`product_email_consent` is the current authority and durable outbox;
`product_email_events` records every consent revision, including withdrawals.
`product_email_intents` holds pending signup choices. The versioned UI copy and
this release's footer copy describe the corresponding consent source; retain
those sources when wording versions change. The database stores server-generated
timestamps and verification references, not codes or bearer tokens. The outbox
holds the edge-observed signup IP temporarily for Buttondown's firewall and
clears it after observing a provider record; it is not copied into consent audit
events. No firewall-bypass header is used.

Public newsletter requests always request Buttondown confirmation. A newly
created subscriber from a verified account with explicit consent may be created
as `regular`. Existing subscribers are never promoted by this adapter. Existing
tags and metadata are preserved; new subscribers get `ship-product-updates`.
An existing `regular` subscriber without local verification evidence remains
pending locally. This avoids treating an anonymous form submission as proof
that the person controls an existing subscriber's address.

The adapter pins `X-API-Version: 2026-04-01` and sends a stable, persisted
`X-Idempotency-Key` on writes. HTTP success alone is not activation: canonical
subscriber status and evidence determine the preference status. Network errors,
429s and provider failures remain in the outbox with bounded exponential delay
(up to a day). There is no fire-and-forget signup work. Accounts cron processes
up to 30 addresses per run and reconciles active addresses daily; confirmation
checks run every five minutes while pending.

Signed webhooks go to `/product-email/buttondown`. Configure the signing key and
newsletter ID; unsigned events and other newsletters are rejected. Raw-body
HMAC-SHA256 is verified with Web Crypto. Event IDs (or a body hash when absent)
are durably deduplicated. The provider does not sign a delivery timestamp, so
replay protection uses that inbox, not a fabricated timestamp header. A signed
unsubscribe is a monotone withdrawal; all other events trigger a canonical read.
Delayed confirmations cannot overwrite a withdrawal. Webhook processing also
retries durably and can match an event arriving before the creation response.

A withdrawal increments the revision and invalidates older jobs. Every provider
write checks the revision and address lease. If a withdrawal races a request
already sent to Buttondown, its result is immediately compensated with an
unsubscribe, and the newer durable job remains due. No system can atomically
commit a local transaction and an external HTTP request; reconciliation repairs
that delivery window. Do not run campaigns while synchronization is unhealthy.
Suppressed addresses (`unsubscribed`, `complained`, `undeliverable`, `blocked`,
`removed`, or locally withdrawn) are never automatically reactivated, even by a
new signup. This release has no suppression-clearing operation.

## Account and browser behavior

Settings → Preferences → Product email preferences opens the authenticated Accounts
page. It uses ordinary HTML forms, same-origin checks and the owner session;
JavaScript is not required. Login, recovery and People invitations have no
marketing requirement. With JavaScript disabled, the signup page explains that
creating a Ship requires JavaScript and links to the server-rendered Accounts
login/preferences flow. Footer subscriptions work in both modes and show a
confirmation-required receipt, never an unsupported “subscribed” claim.

Changing or removing a verified email credential, changing the principal's
address, disabling it or deleting it withdraws associated marketing in the same
SQL transaction. The new address starts without consent and must be verified
and explicitly opted in. Provider-side address changes suppress the old
association and unsubscribe the changed provider record; consent is not copied
to the new address. Deleting a Ship alone is not deleting the account.
Consent/withdrawal evidence is retained separately from active account data;
restrict database access and include it in the operator's retention/deletion
inventory. Do not erase suppression evidence while old jobs or provider records
can still be delivered.

## Configure and roll out

1. Review the runtime, managed-services, infrastructure and website PRs together.
   Pin both infrastructure's runtime and the managed-services runtime gitlink to
   the reviewed runtime commit; pin infrastructure's services gitlink to the
   reviewed service commit. Do not merge or deploy these drafts implicitly.
2. Apply `0026_product_email_consent.sql` through the existing installation
   migration owner runner. On an adopted managed database use the completed
   handoff's **forward** path described in
   [migration adoption](https://github.com/deathbyknowledge/gsv/blob/main/deployment/installation-migration-adoption.md).
   Do not replay the historical mixed Accounts migrations or use Wrangler's
   generic D1 migration command on an adopted database. The new migration has
   no subscriber backfill.
3. Configure an isolated Buttondown test newsletter in staging. Use a key scoped
   to subscriber read/write, without campaign sending rights. Enable signed
   events for subscriber confirmation, unsubscription, type changes, address
   updates and deletion. Use the same configured newsletter ID for API and
   webhook traffic. Do not copy production subscribers into staging.
4. Set `GSV_{STAGING|PRODUCTION}_PRODUCT_EMAIL_ENABLED=true`,
   `...PRODUCT_EMAIL_WEBSITE_ORIGIN`, `...BUTTONDOWN_NEWSLETTER_ID`,
   `...BUTTONDOWN_API_KEY`, and `...BUTTONDOWN_SIGNING_KEY` in infrastructure's
   secret/configuration mechanism. Keys become Accounts-only bindings.
   Native owner email must already be configured. Both product emails and
   service-notice sending default off; the two switches are independent.
5. Ensure the exact `/product-email/*` Accounts routes precede website catch-all
   routes on the configured Accounts origins. Set website
   `GSV_PRODUCT_EMAIL_ORIGIN=https://ship.space` for the Ship alias. The website
   removes direct Buttondown writes and the embedded form bypass. Remove its old
   Buttondown secret after cutover. Legacy waitlist/survey data remains research
   data, not consent; `scripts/pending.sh` no longer offers manual subscription.
6. Verify opt-in, confirmation, unsubscribe from either side, provider downtime,
   stale settings, deletion and address changes in staging. Keep the existing
   owner-mail recipient restrictions for service-notice tests. No test requires
   a production campaign or import.
7. Deploy backend/migration/routes before the website. Provider downtime after
   durable acceptance shows pending; backend downtime before acceptance returns
   a retryable form error. Rollback by disabling new collection in the website;
   keep Accounts withdrawals, webhook processing and reconciliation running.
   Do not roll back the additive migration or resurrect legacy writable flags.

## Essential service notices

Essential notices never use Buttondown or consult marketing consent. They use
Accounts' verified-owner `OWNER_EMAIL` binding. The operator supplies explicit
affected installation IDs; only their current active, verified owners qualify,
with one delivery per principal. Delivery rechecks current ownership and address.
Available fixed templates are `maintenance`, `interruption` and `security`.
Only the service period is variable; there is no promotional message field.

First POST to `/admin/service-notices/dry-run` using the existing operator
Access authentication and exact Accounts Origin header:

```json
{
  "id": "9d837fb1-8081-4d51-9901-948579cb29e1",
  "kind": "maintenance",
  "startsAt": "2026-11-01T10:00:00Z",
  "endsAt": "2026-11-01T11:00:00Z",
  "installationIds": ["the-affected-installation-id"]
}
```

The response contains the exact subject/text, recipient addresses and an
`audienceDigest`. This is admin-only, no-store, and sends nothing. After reviewing
it, the operator may separately enable
`GSV_{STAGING|PRODUCTION}_SERVICE_NOTICES_ENABLED` and POST the same body plus
`audienceDigest` to `/admin/service-notices/queue`. A changed audience requires
another dry run. Reusing a notice ID with different content is rejected.

The delivery ledger claims each recipient before sending. A transport error may
mean mail was accepted; such a row becomes `unknown` and is never automatically
retried. A crash after claiming leaves `sending` with the same protection.
Inspect provider delivery evidence before any manual resolution. Do not reset
these rows to pending just to clear an alert. Duplicate queue requests do not
send again. This favors duplicate prevention over blind retries on a transport
without an idempotent send contract.

## Operations and checks

Inspect outbox lag, `attempts`/`last_error`, unprocessed webhooks, suppression and
`service_notice_deliveries` states. Alert when the oldest due item is more than
15 minutes late, when retries persist, or when a webhook is disabled in
Buttondown. No provider response bodies or customer addresses are logged.
Repeated failures do not exhaust into silently dropped jobs.

Run the focused installation `product-email`, owner API and owner HTTP tests,
the signup component tests, web typecheck/build, website form/localization tests
and managed composition/configuration checks. Tests inject a provider and mail
transport; they do not contact Buttondown or send real messages. Cloudflare's
worker suite is the authoritative integration check; a SQLite test adapter is
useful when a local environment cannot start workerd.

Provider contracts: [versioning](https://docs.buttondown.com/api-versioning),
[idempotency](https://docs.buttondown.com/api-idempotency-keys),
[subscriber creation](https://docs.buttondown.com/api-subscribers-create), and
[signed webhooks](https://docs.buttondown.com/api-webhooks-introduction).
