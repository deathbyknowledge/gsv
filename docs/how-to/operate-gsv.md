# Run Ship for your people

One operator deployment serves multiple isolated installations. The public
composition includes the installation directory, administration, Gateway,
storage, ripgit and inference execution, and the open-network host once it is
configured. Each installation keeps its own Kernel,
accounts, credentials, processes and data. H&M funding or billing services are
optional operator integrations.

The reference composition is [`alchemy.run.ts`](https://github.com/deathbyknowledge/gsv/blob/main/alchemy.run.ts). Configure
Alchemy's Cloudflare account/authentication and set these deployment inputs:

| Input | Purpose |
| --- | --- |
| `GSV_DOMAIN` | Base domain for installation hostnames. |
| `GSV_ZONE_ID` | Cloudflare DNS zone containing that domain. |
| `GSV_ADMIN_ORIGIN` | Administration origin; defaults to `https://accounts.<domain>`. |
| `GSV_WORKER_PREFIX` | Physical resource name prefix; defaults to `gsv`. |
| `GSV_ALLOW_RESOURCE_DELETION` | Explicit physical resource deletion opt-in; defaults to `false`, including in CI. |
| `GSV_ACCESS_MODE` | `operator` or `access`; defaults to `operator`. |
| `GSV_ACCESS_TEAM_DOMAIN`, `GSV_ACCESS_AUDIENCE` | Required for Cloudflare Access mode. |
| `GSV_OWNER_EMAIL_FROM` | Verified sending address for native email-code owner sign-in, My Ships and recovery. |
| `GSV_OWNER_EMAIL_REPLY_TO` | Optional reply address for owner verification mail; defaults to the sender when omitted. |
| `GSV_OWNER_EMAIL_ALLOWED_RECIPIENTS` | Optional comma-separated recipient restriction for owner verification mail, useful on staging. |
| `GSV_OWNER_OIDC_ISSUER`, `GSV_OWNER_OIDC_CLIENT_ID`, `GSV_OWNER_OIDC_CLIENT_SECRET` | Optional owner identity provider for account linking and root recovery; issuer and client ID must be supplied together. |
| `GSV_ADAPTERS` | Comma-separated operator-enabled adapter IDs; empty by default. |
| `GSV_INFERENCE_PROVIDER`, `GSV_INFERENCE_MODEL` | Operator default provider and model. |
| `GSV_INFERENCE_API_KEY`, `GSV_INFERENCE_BASE_URL` | Optional operator provider credentials and endpoint. |
| `GSV_DELETION_CATALOG_FILE` | Path to a JSON array declaring current and historical external resources for deletion; see below. |
| `GSV_PLC_ROTATION_KEY` | Runs the [open-network host](../architecture/open-network.md#deployment) at `pds.<domain>`. The secp256k1 private key, as 64 lowercase hex characters, that signs every Ship's DID operations; generate it once and keep it secret. |
| `GSV_PLC_RECOVERY_KEY` | Optional `did:key` of an offline key that outranks the rotation key in every new DID. |
| `GSV_PLC_URL` | The did:plc directory the host registers DIDs with and Ships read them from; defaults to `https://plc.directory`. |
| `GSV_PDS_CONTACT_EMAIL` | Optional public address where relays and other services can reach you about the host. The host's `describeServer` answer names it. |
| `GSV_PDS_PRIVACY_POLICY_URL`, `GSV_PDS_TERMS_OF_SERVICE_URL` | Optional HTTPS links to your privacy policy and terms of service, which `describeServer` lists. |
| `GSV_PDS_LEXICON_HANDLE` | Optional handle of the [account that publishes Ship's lexicons](../architecture/open-network.md#the-lexicon-account), such as `lexicons.<domain>`. Deploying never creates that account; see [Publish the lexicons](#publish-the-lexicons). |
| `GSV_PDS_RELAYS` | Optional comma-separated HTTPS origins of the [relays](../architecture/open-network.md#relays) the host asks to follow it, such as `https://bsky.network`; empty by default, so no relay hears of the host. See [Announce the host to relays](#announce-the-host-to-relays). |

Optional inference ceilings are `GSV_INFERENCE_MONTHLY_REQUESTS`,
`GSV_INFERENCE_MONTHLY_OUTPUT_TOKENS`, `GSV_INFERENCE_MAX_OUTPUT_TOKENS` and
`GSV_INFERENCE_MAX_DURATION_MS`. The default Workers AI route uses the operator's
Cloudflare account. Installations can also configure their own model credentials;
provider execution uses the same public service either way.

Isolated deployments attached to pull requests use the same public stack,
normal onboarding and included inference, with explicit disposable resources.
Their workflow is described in the repository's engineering notes.

Owner verification emails include a large, selectable six-digit code and its
remaining lifetime in minutes, with a plain-text alternative. A resend keeps
the original expiry and shows the remaining time. The sender display name is
Ship. To send from `login@ship.space` and direct replies to the support inbox,
configure:

```sh
GSV_OWNER_EMAIL_FROM=login@ship.space
GSV_OWNER_EMAIL_REPLY_TO=hello@humansandmachin.es
```

The sender domain must be enabled for Cloudflare Email Sending in the deployment
account. A sender profile picture is configured with the mail provider or through
domain branding such as BIMI; it is separate from the email template.

Build and review the deployment before applying it:

```sh
npm run deployment:build
npx alchemy plan --stage operator
npx alchemy deploy --stage operator --yes
```

The release manifest is version 4 and includes the installation directory Worker,
its public migrations, the inference Worker and the open-network host alongside
Gateway, web assets, ripgit and adapter bundles. A version 1 singleton bundle is not accepted by this
composition. Existing singleton deployments require an explicit migration before
upgrading; existing multi-installation operators must preserve their physical
resource identities and complete the directory migration ownership handoff.

After the first successful apply, use the deployment's directory database ID and
administration origin with the [bootstrap command](https://github.com/deathbyknowledge/gsv/blob/main/deployment/operator-bootstrap.md).
It prints a one-time link only to your local controlling terminal. The link
creates the first Ship and its activation link. Further Ships
are created explicitly in administration. Ordinary redeployments do not create
Ships or rotate credentials.

### Publish the lexicons

A deployment with `GSV_PDS_LEXICON_HANDLE` publishes Ship's lexicons from an
account of its own once you create it. Creating it registers a DID with the PLC
directory for good, so each step is yours to run, once, with
`GSV_PLC_ROTATION_KEY` in your environment:

1. Create the account. The command prints the DNS record that verifies its
   handle.

   ```sh
   npm run pds:lexicons -- create --pds https://pds.<domain> --handle lexicons.<domain>
   ```

2. Add the `_atproto.lexicons.<domain>` TXT record it printed.
3. Publish. Every lexicon becomes a public record in the account's repository,
   which relays copy.

   ```sh
   npm run pds:lexicons -- publish --pds https://pds.<domain>
   ```

4. Only for the deployment that speaks for `space.ship`, add the
   `_lexicon.ship.space` TXT record `did=<the account's DID>`.

After the first publish, each deployment's changed lexicons go out within ten
minutes. `npm run pds:lexicons -- status --pds https://pds.<domain>` shows the
account and the lexicons waiting to go out.

### Announce the host to relays

Bluesky and other apps read what Ships publish through a relay, which follows
the host only once the host asks it to. Name the relays in `GSV_PDS_RELAYS`,
such as `GSV_PDS_RELAYS=https://bsky.network`, and deploy. Within ten minutes
the host asks each one to follow it, and it asks again when it has new events
and twenty minutes have passed, so a relay that dropped the host picks it up
again. The PDS Worker's logs show a warning each time a relay refuses or can't
be reached, naming the relay and any HTTP status and XRPC error; the host then
waits longer before asking that relay again, up to six hours.

Check what a relay knows of the host with
[goat](https://github.com/bluesky-social/goat), which asks `bsky.network`
unless you name another relay:

```sh
goat relay host status pds.<domain>
goat relay --relay-host https://relay.example host status pds.<domain>
```

It shows whether the relay follows the host, the last event it read and how
many of the host's accounts it knows. A relay limits that number for each
host. The reference relay that Bluesky operates follows 100 accounts on a new
host by default and drops the events of any past that, so ask the relay's
operator to raise the host's limit before the host has more accounts than
that.

A relay reads the host only from the moment it joins, so from its first run
after a relay accepts, the host introduces every active Ship it already holds,
200 a run, as it announced each Ship when it was created. A Ship past the
relay's account limit misses that introduction. Once the limit is raised, take
the relay out of `GSV_PDS_RELAYS` and deploy, wait for the next ten-minute run,
then name it again and deploy: the host forgets a relay at its first run
without it, and introduces every Ship to it again once it's named anew. That
run happens only while the deployment names another relay or a lexicon
account.

## Give someone a Ship {#give-someone-a-space}

Operator administration and owner sign-in have separate jobs. In `operator`
access mode, open `<admin-origin>/operator` and sign in with the operator
credential saved during bootstrap. In `access` mode, open
`<admin-origin>/admin` through the configured Cloudflare Access policy.
Create a Ship, reserve its handle, and give the person the resulting one-time
activation link. They use that link to create their personal account and root
password. Further Ships use this same administration flow.

Open **Signup** in administration (`<admin-origin>/admin/signup`) to edit the
reserved and blocked username lists. Both lists start empty; add the names you
want to reserve or block, then save. Reserved names can be assigned to
operator-controlled Ships through administration; blocked names cannot be assigned
to any new Ship. Save changes to apply them immediately. Matching ignores case,
accents and separators, but checks the whole name. Existing Ships and unfinished
activations keep their names. See the [username policy](../architecture/installation-directory.md#open-registration)
for matching rules and terms that require contextual review.

Administration timestamps use your device's timezone, including audit entries and
run times. With JavaScript disabled, they use the labelled UTC fallback.

To let people sign up themselves, enable `GSV_SIGNUP_ENABLED` and configure
owner email delivery. They choose a handle and verify their email at
`<admin-origin>/owner/signup/`, the configured public signup alias, or in
Desktop. Registration needs no invite code. One verified email can create one
Ship, and an interrupted activation resumes with the same email.

With native owner email enabled, `<admin-origin>/owner/login` verifies the
person's email and opens **My Ships**. Signing in there does not create a
Ship or grant operator administration. To add an operator-created Ship to that
list, sign in as **root**, open **Settings → sign-in → Account recovery**, and
choose **set up recovery**. This binds current root authorization to the verified
email. The owner can then see the Ship in **My Ships** and start administrator
recovery there if needed.

The sending address must be enabled with the provider and its DNS records
verified before codes can be delivered. The public deployment creates and
preserves the owner-authentication secret. Keep the deployment state on
redeploy so existing verification and session records remain usable. Owner
verification mail is independent of a Ship's messaging adapters.

## Reset a Ship {#reset-a-ship}

A reset gives the same person a fresh Ship under the same handle, and it can't
be undone. If the person only lost access, don't reset: recovery keeps their
Ship, contacts and DID. They sign in to **My Ships** at `<admin-origin>/owner/login`
with the owner email that the Ship's page shows, and choose **Recover your
Ship** to reset the administrator password. A Ship whose owner isn't linked
can't be recovered this way.

The **Reset** panel on the Ship's administration page says this first, then
what a reset does before you confirm:

- The person gets a new Ship at the same address and can't return to the old
  one. They set it up again from a new activation link, and sessions, devices,
  messengers and background work on the old Ship stop.
- They get a new identity on the open network: the new Ship registers a new
  DID.
- Their contacts end, and each one needs a new invitation.
- Their public profile and records stop being served, and leave the open
  network when the old Ship's data is erased.
- Nothing is erased yet. The old Ship's data is kept as pending deletion until
  a separate deletion removes it; see
  [Connect services and verify cleanup](#connect-services-and-verify-cleanup).

Give a reason, which the audit log keeps, and type the Ship's handle to
confirm. The page then shows the new Ship's activation link once; give it to
the person.

The operator API needs the same handle and reason. Without either it answers
400 and lists what a reset does, and a retried reset doesn't make another Ship.

## Check on a Ship {#check-on-a-ship}

Each Ship's administration page shows its handle, mail address, hostnames and
lifecycle state. It also shows the owner's full email, as a `mailto:` link,
and their sign-in methods. Set `GSV_MAIL_DOMAIN` to show the Ship's mail
address.

When Accounts has the `OPERATOR_GATEWAY` binding, the page adds health from the
Ship itself: the personal process state, queued input, pending approvals, open
responsibilities, queued Ship events, linked messengers and connected devices.
Administration reads this through a deployment-owned binding to the Gateway
that only Accounts holds, and only for a Ship the directory lists as active or
suspended. Devices appear as `Device 1`, `Device 2` and so on, numbered by first
connection, because their own names often include a person's name.

A timeline lists the most recent runs. Each run shows its origin, input length,
duration and outcome, and its steps flag anything that failed or took longer
than a minute. If the Ship's own process cannot be read, the timeline says "Run
history unavailable" rather than showing no runs.

Health and the timeline are metadata only: counts, times, tool and model names,
and outcomes. They never include message text, tool arguments or output,
prompts, file contents, or the identifiers of people a Ship talks to on a
messenger. The health read gives up after three seconds. If the binding is
missing or the read fails, the page names the reason and the rest of it still
works.

Accounts records every operator change in an audit log: creating a Ship,
reissuing its setup link, suspending, reactivating, resetting, taking down and
restoring what it publishes, and each deletion step. Each entry names the
operator and the action, plus any reason the operator gave. Suspending,
reactivating and restoring take an optional reason; resetting or retiring a
Ship, and a takedown, require one. A Ship's
page lists its recent entries, and `<admin-origin>/admin/audit` lists every
entry. Entries outlive the Ship they describe. They name it only by Ship ID and
hold no owner data.

Accounts writes the entry before the change runs. If it cannot, the change does
not happen and the operator gets a retryable error. A change that returned an
error is marked "Returned an error". If the outcome could not be written after
the change ran, the change is still reported as done and its entry reads
"Outcome not recorded"; check the Ship's current state.

On a deployment that runs the open-network host, suspending a Ship also tells
relays that its account is suspended, and reactivating it tells them the
account is active again. If the PDS can't be reached, the Ship keeps its new
state and the error says that relays weren't told. **Try again** on the error
sets the same state again: Accounts changes nothing, tells relays, and records
the attempt in the audit log. Through the operator JSON API, send the same
state again.

## Take down what a Ship publishes {#take-down-what-a-ship-publishes}

When a Ship publishes something that breaks your rules, you can take down just
that instead of suspending the Ship. On a deployment that runs the open-network
host, each Ship's page has a **Takedowns** panel under its actions. It shows
the Ship's DID and handle and everything currently taken down, with the reason
and the audit event behind each.

Choose what to take down:

- **Record** takes down one record by its AT URI, such as
  `at://did:plc:…/space.ship.profile/self` for the Ship's public profile, or
  `at://did:plc:…/app.bsky.actor.profile/self` for the copy of it that
  Bluesky shows. Accounts looks up the record's current version for you.
- **File** takes down one blob by its CID, such as a profile picture.
- **Whole account** takes down everything the Ship publishes. Until you restore
  it, the Ship can't publish or call other Ships, so its person can't message
  their contacts either; what they send fails at once with that reason. Their
  contacts' messages still arrive, and everything else in the Ship keeps
  working.

Write the reason the Ship's person will read in People, then choose **Take
down**. The PDS stops serving it at once, and relays learn of an account
takedown from its firehose; copies that apps and relays already made are
theirs. Accounts then tells the Ship, which brings the copy of its profile that
Bluesky shows in line at once: it deletes the copy while you have the profile or
the copy down, and leaves the picture out while you have its file down. An
account takedown leaves the copy as it is, because relays hide the whole
account. **Restore** brings it back, with an optional reason for the audit log,
and the Ship writes its full copy again. The person sees each takedown in
People, on their profile, with your reason.

Each takedown's and restore's audit entry says what became of the copy:
`bluesky: removed`, `updated` or `unchanged`. `bluesky: unreachable` means the
Ship couldn't be told, for example while it restarts. The takedown still stands;
take the same subject down again to tell the Ship again. A restore the Ship
missed reaches Bluesky at its person's next sign-in or message to their Ship.

The operator JSON API takes down and restores the same way, under the same
audit. Takedowns need Accounts' `PDS_MODERATION` binding, which the
composition adds with the PDS; see
[the open network](../architecture/open-network.md#takedowns).

## Review reports {#review-reports}

People on your Ships can report a message request from someone they don't
know. **Reports** in Accounts lists the open reports, newest first, and the
closed ones with how each closed. A report names the Ship whose person reported
it, and the sender by DID and handle, with what the person picked and when the
request arrived and was reported. The sender's name and message are there only
when the person chose to include them. Accounts erases the name and message
90 days after the report closes, keeps the rest until the reporting Ship is
deleted, and forwards no report to other hosts.

Open a report to act on it:

- **Take down** appears when this deployment's open-network host holds the
  sender's account. It takes the whole account down, as
  [Take down what a Ship publishes](#take-down-what-a-ship-publishes)
  describes, with a reason the sender's person reads, and closes every open
  report of that sender. A sender hosted elsewhere can't be taken down from
  here.
- **Dismiss** closes the report without acting on the sender, with an
  optional reason for the audit log.

Both actions run under the operator audit log. A report's trail lists every
audit event that names it, including a takedown that failed, so you can see
what was tried before it closed. Reports need Gateway's `REQUEST_REPORTS`
binding, which the composition adds; see
[request reports](../architecture/open-network.md#request-reports).

## Connect services and verify cleanup

Enabled adapters require their application secrets declared in the adapter
manifest, along with its `requiredVariables`. Telegram needs its bot username
and public webhook origin, Slack its public origin, and Discord its application
ID. A manifest's `optionalVariables` reach the Worker only when set, so an
explicit empty value still counts; WhatsApp uses this for
`WHATSAPP_UNREACHABLE_CALLING_CODES`. The common runtime binds Accounts, Gateway and each adapter's lifecycle
service; the manifest inventories every owned Durable Object namespace,
including retained legacy namespaces. Their public callback routes and provider application registration
belong to the operator; enabling a Worker alone does not complete that external
provider setup. People pair their own identities through their installation.

Before deleting an installation, account for every service that still holds its data,
including services previously enabled. `GSV_DELETION_CATALOG_FILE` supplies the
external-resource catalog to the public composition. Each entry declares an
`id`, physical `namespace`, `kind`, `source`, `scope` (`installation` or
`deployment`), and `disposition` (`live` or `retained`). Include logs, telemetry
exports, provider copies, caches, backups, unfinished R2 uploads, and mail queues
and dead-letter queues where applicable. Queues and unfinished uploads are live
resources. Current bindings and default-provider settings cannot establish the
complete history of destinations, including people's own provider accounts.
Leave the catalog unset while that inventory is unresolved; deletion admission
fails closed. A configured catalog declares scope, not successful cleanup. A
deployment that runs the open-network host also catalogs its bucket's
unfinished uploads and, when they persist, its Worker's logs. Deleting an
installation then deletes its Ship's public account and tombstones its DID,
which can't be undone; see [the open network](../architecture/open-network.md#deletion).

Retiring a Ship, the first step of deleting it, stops it for good with nothing
in its place. Like a reset, it needs the Ship's handle typed as confirmation
and a reason; without either, Accounts refuses it and says what retiring does.

Deleting an installation is a resumable operation. Accounts verifies the resource
inventory before cleanup starts, every owning service reports its own erasure
receipt, and verified live-data erasure is reported separately from retained
copies such as backups, queues and provider logs. Known, enforced retention can
remain pending with its declared expiry visible; the operation does not claim
final erasure until every live scope is empty and every retained copy is
deleted or expires. Operators running the directory themselves follow the
deletion contract in the repository's engineering notes.

For local development, `npm run dev` builds the SDK and web assets, applies public
migrations to a separate local database and runs the four public Workers. Open
`http://localhost:8976/admin`, create a Ship and follow its activation link at
`http://<handle>.localhost:8976`. No private repository is required. The local
administration bypass admits only the configured localhost origin; both local
development scripts bind to `127.0.0.1` so this bypass is not exposed to the LAN.
The default state directory is `.wrangler/operator-dev-state`; set `GSV_DEV_STATE_DIR` to use
another disposable directory. Model calls still require an available provider.

This composition and the migration tooling have local D1 and configuration tests.
Local success is not evidence that a cloud deployment has completed; verify a
fresh deployment end to end before giving anyone a Ship on it.

## Optional signup emails

The web signup header links to the configured primary domain. The handle/email
form has no Back button; other public signup steps link Back to that homepage.
**Already have a Ship?** in the center of the signup top bar links to
`/owner/signup/?view=welcome`, which offers both creating a Ship and opening
an existing one by email or space address.

During signup, people can optionally check **Email me occasionally with cool Ship updates**.
The box starts unchecked and is separate from the required account agreement.
For new signups, Accounts queues explicit choices made when creating a Ship with a verified
email. Sign-in and email verification alone never subscribe anyone.

To deliver these requests, apply `0034_product_email_signup.sql` and
`0035_product_email_users.sql`, bind an
Accounts-only `BUTTONDOWN_API_KEY`, and set `GSV_PRODUCT_EMAIL_ENABLED=true`.
The Accounts scheduled handler calls `runProductEmailJobs`; commercial
compositions import it from the installations package's `product-email` export.
Requests wait durably while sending is disabled or Buttondown is unavailable.
Inspect `product_email_signups.due_at`, `attempts` and `last_error` for failures.
Retries reuse one request ID, and completed requests are not replayed.

Buttondown owns subscriptions and the unsubscribe link in each product email.
Checked signups receive the `user` tag. New subscribers receive
that tag; existing subscribed addresses have it appended without replacing tags
such as `early-access` or changing their subscription state. Pending, unsubscribed,
blocked and other suppressed addresses remain untouched. Signup requests store the choice's wording version, locale, timestamp
and verified address; the temporary signup IP is cleared after delivery.
The adapter uses Buttondown's [subscriber API](https://docs.buttondown.com/api-subscribers-create),
[tag append behavior](https://docs.buttondown.com/tags)
and [idempotency keys](https://docs.buttondown.com/api-idempotency-keys).


Migration `0035_product_email_users.sql` also queues a one-time backfill of
existing verified, active owners with at least one active Ship. It excludes
unverified or disabled owners, incomplete signups and retired Ships. Multiple
Ships for one email produce one request. Backfill records use source
`ship-existing-user-backfill`, wording version `operator-backfill-2026-10-30`
and locale `und`; these identify an operator backfill, not a recorded checkbox
choice. Existing signup records retain their original evidence. Previously
completed requests are checked again for the `user` tag with new idempotency
keys, preserving any existing `newsletter` or `early-access` tags.

Keep delivery disabled while applying the migrations and deploying the updated
Accounts worker, then enable it. The existing cron drains the backfill in batches
of 30, using the same retries and Buttondown suppression checks as new signups.
The migration takes a snapshot; users created afterward still need the checkbox.
Verify one new opted-in signup and one backfilled owner in Buttondown before
considering rollout complete.
