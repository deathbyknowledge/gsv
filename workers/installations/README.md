# Installation services

This is the public Accounts implementation being extracted during hosting
consolidation. It owns directory identity, principals, ownership, setup claims,
and durable reset preparation. It does not read or write funding-policy tables.

The Worker exposes the existing directory and onboarding RPC contracts. Its
HTTP surface currently contains only health. Operator administration HTTP/access, principal
sign-in/recovery, the common bootstrap, and production adoption are subsequent
consolidation batches; this is not yet the complete replacement deployment.
H&M consumes the exported directory/administration stores and reset coordinator
while its existing Worker still hosts operator administration HTTP and private
commercial services. Public administration owns installation lists, details and
active/restricted transitions; its queries require no commercial tables.

Run `npm run typecheck --workspace @humansandmachines/gsv-installations` and
`npm test --workspace @humansandmachines/gsv-installations` from the repository
root. Tests create a fresh directory-only D1 and exercise actual Worker RPCs.
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
