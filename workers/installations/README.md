# Installation services

This is the public Accounts implementation being extracted during hosting
consolidation. It owns directory identity, principals, ownership, setup claims,
and durable reset preparation. It does not read or write funding-policy tables.

The Worker exposes the existing directory/onboarding RPC contracts, installation
administration HTML screens, and the JSON API. Accounts owns listing, details,
creation, onboarding reissue, active/restricted transitions and reset
orchestration; none of these operations requires commercial tables. H&M uses the
same controller, pages, API, Access verifier and administration service. Its
private presentation adds navigation, a list summary column and installation
detail slots; those trusted renderers own escaping their data. Funding forms
and inference routes remain private. Owner sign-in and root recovery use the
shared identity flow described below. Operator-token login, common bootstrap
and production adoption are subsequent batches; this
is not yet the complete replacement deployment.

The HTML registry is available at `/admin` and `/admin/installations`, with a
creation form at `/admin/installations/new` and details and lifecycle controls
at `/admin/installations/:id`. The shared stylesheet and layout preserve the
existing operator UI. HTML responses are never cached, and onboarding links
suppress referrer disclosure when opened.

The API uses `/admin/api/installations` for listing and creation, and
`/admin/api/installations/:id` for details. POST actions are `onboarding`,
`lifecycle` and `reset`. Mutations require the exact configured Origin; creation
and reset retain their operation ids, and reset requires the current handle as
confirmation. JSON and HTML form bodies are bounded while reading. JSON claim
responses are never cached and suppress referrer disclosure.

Production access requires an RS256 Cloudflare Access JWT matching
`GSV_ADMIN_ACCESS_TEAM_DOMAIN` and `GSV_ADMIN_ACCESS_AUD`; the default empty
configuration denies access. Set `GSV_ADMIN_ORIGIN` to the operator origin.
Explicit development mode permits only the exact configured HTTP localhost
origin. The shared interface allows the forthcoming operator-credential access
implementation without duplicating routes or lifecycle operations.

The public reference Worker creates reservations under `principal_operator_registry`.
This deployment-owned placeholder does not prove an individual owner's identity.
A root human links a verified external identity before owner recovery is enabled. H&M supplies its
existing registry identity to preserve adoption. Caller-provided principal ids
cannot change the reservation owner. Reset participants are supplied by the
hosting composition; the reference Worker currently has no optional services.

Run `npm run typecheck --workspace @humansandmachines/gsv-installations` and
`npm test --workspace @humansandmachines/gsv-installations` from the repository
root. Tests create a fresh directory-only D1 and exercise actual Worker RPCs,
the JSON API, and the HTML create, reissue, lifecycle and reset flow.
The compatibility date remains the extracted service's existing date so that
moving ownership does not also change runtime semantics.

## Schema ownership

The shipped SQL in `0001`, `0002`, `0006`, and `0010` is copied unchanged from
the existing directory. The numeric gaps belong to private inference policy
and usage; they are deliberately absent here. `0011` adds directory-owned
reset participants and an activation guard. Service-owned preparation receipts
stay with the participating service.

Fresh public databases use `installation_migrations`. Existing H&M databases
still use their legacy runner in the deployment overlay. Do not point this
fresh migration runner at an existing database: adoption must first verify the
legacy migration inventory/checksums and seed the new owner ledger, as specified
in `engineering/hosting-consolidation-spec.md`. No legacy columns, resources or
records are removed by this extraction.

## Owner linking and root recovery

Configure an OIDC application with issuer `GSV_OWNER_OIDC_ISSUER`, client ID
`GSV_OWNER_OIDC_CLIENT_ID`, and optional confidential-client secret
`GSV_OWNER_OIDC_CLIENT_SECRET`. Its HTTPS callback is
`GSV_ADMIN_ORIGIN/owner/callback`. The provider must support authorization code
flow with PKCE, RS256 ID tokens, nonce, verified email, and `max_age=0` with a
fresh `auth_time`. Issued-at time alone is insufficient. Operator Access
authorization remains separate and does not prove ownership of a space.

Gateway binds `INSTALLATION_OWNERSHIP` to Accounts'
`InstallationOwnershipEntrypoint` with deployment-owned props
`{ authority: "kernel-owner-link" }`. Accounts binds `ACCOUNTS_GATEWAY_RECOVERY`
to `GatewayRecoveryEntrypoint` with props
`{ authority: "installation-owner-recovery" }`. Missing configuration denies
owner operations. A directory binding alone grants no incoming recovery authority.

In Settings, a signed-in root human starts a ten-minute link attempt. The
Kernel fixes its own installation identity and credential generation. Accounts
verifies the person's provider subject and atomically replaces registry
ownership and membership; it never issues a local credential. Before committing,
Accounts confirms that the original root authorization remains valid. The same
principal may link several spaces; email matching never merges distinct subjects.

`/owner/recover` freshly authenticates the current verified owner of a space.
Accounts grants an exact, expiring root-reset claim and redirects the browser
to that space's `/recover` page. Kernel redemption changes only root's password
and revokes earlier root tokens, sessions, pending device invitations and root
adapter links. An identical receiver-bound retry returns the existing receipt
without overwriting later changes or disconnecting newly authenticated sessions.
Existing ordinary human credentials and data remain unchanged. Root recovery
also revokes enrolled root passkeys. Kernel Settings owns people, human
invitations, member password resets, removal, and passkey enrollment/revocation.

Members can recover at `/recover-member` using a private messenger link they
previously confirmed while signed in. The Kernel sends a five-minute code through
the exact linked adapter route without waking a model. The browser stores a
random proof before requesting the code; only that browser can redeem it. A
successful reset revokes that member's previous credentials and messenger links.
Manual or legacy links without direct human confirmation require relinking while
signed in or a root password reset. Ordinary password sign-in remains available
alongside passkeys.

`0013_installation_owner_identity.sql` adds the external-subject mapping and
durable owner attempts. On an existing H&M database it runs only through the
directory-owned runner after the legacy migration handoff. Do not copy it into
or run it through the retired private legacy migration directory.

## Reset preparation

The coordinator records an immutable participant list in the same transaction
that retires the previous identity and reserves its replacement. Each service
owns its policy transfer and durable receipt. A lost reply is replayed with the
same operation and installation identities; an acknowledgment must match all
three. Removing a configured participant does not bypass a pending obligation.

The database prevents provisioning or activation while a participant is pending,
including writes from an older Worker during deployment. The hosting Worker
calls `resumePending()` periodically and supplies the same registered services.
Reset preparation does not erase data: the previous installation remains marked
as pending deletion until a verified owner inventory admits the cleanup operation.

## Installation deletion

Apply `0017_account_deletion.sql` through the directory-owned migration runner
before deploying these handlers. Configure lifecycle service bindings named
`DELETION_OWNER_<OWNER>`; names become lowercase owner IDs with underscores
converted to hyphens. `accounts` is always the local D1 owner. Bind the gateway
to its `GatewayLifecycleEntrypoint` with deletion authority and provide every
other owner named by the verified inventory, including services no longer enabled.
The shared runtime is exported from `@humansandmachines/gsv-installations/deletion`.
Reference and private Workers call the same runtime from their scheduled handler;
the deployment must configure a periodic cron trigger.

`DELETION_INVENTORY` is a deployment-owned `InstallationDeletionInventoryResolver`.
It authenticates discovery provenance and verifies pagination, configured namespaces,
every resource's stored identity, and the exact owner set. Missing or unmapped
historical resources prevent registration. The registry checks the returned scope
and canonical manifest digest; a caller cannot submit a completeness flag.
Evidence contains only resource addresses and enumeration metadata. Each uploaded
body is limited to 512 KiB and is verified against the manifest's SHA256 reference;
up to 8 MiB is stored in individual D1 rows. The canonical manifest is at most 1 MB.
Resolvers may instead fetch evidence references from their owned storage.

The existing operator authentication and exact mutation Origin protect these JSON
routes under `/admin/api/installations/:id/deletion`:

- `POST /retire` takes `operationId` and `confirmHandle` to close admission for
  explicit deletion without creating a replacement. A required reset preparation
  must finish first. Retired reset sources already have closed admission.
- `POST /inspect` takes the shared lifecycle inspection request and probes only
  through the trusted gateway discovery capability.
- `POST /inventory` registers a manifest, or `{ manifest, evidence }` where each
  evidence entry has `reference`, `sha256`, and its exact UTF-8 `body` string.
- `POST /import` takes the shared import request with the registered canonical
  manifest hash in `discoverySha256`. Its complete gateway/ripgit DO list must
  match the manifest exactly; repeating the request resumes bounded owner work.
  Admission waits for the owner's final verified import acknowledgment.
- `POST` on the base route takes `operationId` and `inventorySha256` to begin.
  Explicit retirement and begin use the same operation ID. `GET` reports status,
  and `POST /retry` advances the durable operation.

After verified registration/import, the scheduled job also admits already-pending
reset deletions whose service preparation is complete. Unverified pending resets
are left alone. Every owner quiesces before erasure; Accounts retains its directory
and resource inventory until all external owners report live-data erasure. D1
cleanup is bounded to 100 rows per table per call. SQL retirement guards reject
late claims, memberships, provisioning, and identity recreation. Minimal operation
ID tombstones also prevent a delayed create retry from allocating a new space.
Shared principals, another space's data, and operator credentials remain owned by
their original boundaries.

Accounts reports live erasure separately from D1 Time Travel retention. The default
expiry is 30 days plus one minute after the last live row is erased, covering
[D1's documented recovery window](https://developers.cloudflare.com/d1/reference/time-travel/).
`ACCOUNTS_D1_BACKUP_RETENTION_MS` may supply a positive, verified operator policy;
the chosen expiry is recorded once. Exported backups, provider copies, and logs
remain separate inventoried owners. Final completion waits for every retained copy.
After erasure, directory lookup of the immutable ID returns `deleted` with inert
placeholder routing metadata; hostname lookup is absent. Only content-free
identity, operation and terminal-state tombstones survive.
