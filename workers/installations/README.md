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
and inference routes remain private. Owner sign-in/recovery, operator-token
login, common bootstrap and production adoption are subsequent batches; this
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
This deployment-owned placeholder does not prove an individual owner's identity;
owner linking/recovery remains a separate implementation step. H&M supplies its
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
