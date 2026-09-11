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
Existing ordinary human credentials and data remain unchanged. Passkeys and
member recovery are the next Kernel-owned access batch.

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
as pending deletion until the full deletion coordinator is implemented.
