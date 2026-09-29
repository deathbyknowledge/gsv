# Hosting consolidation: review history

This file preserves the revision 1–3 review discussion and subsequent
maintainer decisions verbatim. Statements below describe those revisions;
they are historical, including any labels saying a question is open.
The current implementation plan and acceptance criteria are in
[hosting-consolidation-spec.md](./hosting-consolidation-spec.md).

## 9. Review feedback — Astra, 2026-09-11

Status: open review notes; the proposal above is preserved unchanged. Reviewed
against GSV `a47a0e66` and the current private Accounts implementation.
References beginning `../infrastructure/` are relative to the GSV repository
root. Each required decision applies before its affected workstream ships;
these notes do not block documenting the existing contracts.

The shared public composition, closed registration, resource adoption, two
validation environments, and explicit standalone cutover are the right
direction. The following points need clarification or correction.

### R1. Define human admission and a safe membership backfill

**Required for W1; affects sections 2, 3, 5, and 6.** The current directory
contract resolves installations and their state; it does not authenticate a
human or resolve their membership. Accounts writes pending memberships, while
the Kernel still authenticates local passwords and human/machine/service
tokens. Moving to directory-controlled human admission is new behavior.

There is also a concrete backfill problem:
`../infrastructure/services/accounts/src/admin/service.ts` creates
installations under the shared `REGISTRY_PRINCIPAL_ID`. That provisioning
principal is not evidence of the actual human owner's identity. Neither a
matching username nor an inference usage uid establishes that ownership.

Specify how a human authenticates to the directory without optional mail or
H&M services, how an existing authenticated Kernel human proves the account
being linked, and how the directory receives the Kernel-assigned uid through a
trusted operation. Public input cannot select another person's uid. Define
which admissions check membership and what revocation does to existing web
sessions, CLI credentials, and adapter links, including the boundary for work
already admitted.

**Acceptance addition:** migrate two installations created under the shared
registry principal to their respective real humans; neither can claim the
other's account. Test a second member, one principal in two installations, and
revocation through each supported entry path. Keep this behavior change a
separately reviewable batch from contract documentation and role removal.

### R2. Share invitation semantics while fixing purpose and ownership

**Required for W1.** The vocabulary currently calls a machine a local account.
`workers/gateway/src/kernel/accounts.ts` creates human and agent accounts;
device pairing issues a machine peer credential under an existing owner's uid,
bound to a target. It does not create a human account or grant a human session.
Correct the vocabulary so invitation reuse preserves that distinction.

The invitation should fix its purpose, installation, issuing authority, and
permitted enrollment. The recipient must not select a different principal kind
or grant at redemption. Existing device consumption is atomic inside the
Kernel; a directory membership and Kernel account cannot share that transaction.
Define who owns consumption and the durable completion receipt, including
recovery when one side commits and the other side or its acknowledgment fails.

**Acceptance addition:** concurrent redemption creates one enrollment; a lost
response is recoverable by the same recipient; another recipient cannot reuse
the claim. Expiry, cancellation, issuer revocation, and installation reset
cannot activate a stale membership. A machine invitation cannot enroll a human.

### R3. Specify D1 adoption and separation before moving migrations

**Required for W2/W4.** The public table list omits `principals`, which both
`installations` and `memberships` reference. Existing migrations interleave
installation and commercial tables. Inference usage and policy tables have
foreign keys to `installations`, inference policy queries join that table,
and installation administration joins private policy/usage tables.

Moving files into separate migration directories does not resolve those
dependencies. Choose the destination databases and migration bookkeeping,
identify which service calls replace cross-owner joins, and describe how
existing data and in-flight usage writes survive the transition. Preserve
shipped migrations; define the adoption path explicitly alongside the fresh
database path. Drop `role` through that migration path, not by editing the
original shipped schema.

The public installation state also contains `trialing` and `past_due`.
Specify how private commercial policy projects into public lifecycle/admission
state, retaining the current active-only work gate.

**Acceptance addition:** run both migration paths with installation records,
pending onboarding/reset operations, and commercial policy/usage present.
Resolution, reset/deletion cleanup, and usage recording must still work after
the split, without replaying an incompatible baseline or losing records.

### R4. Distinguish operator bootstrap from ongoing administration

**Required for W3; affects section 8.** W3 makes the operator token single-use
and expiring, but also makes it the continuing administration path. Define the
credential or session that exists after that first use.

Either use an operator credential disclosed once and subsequently reusable
until rotation/revocation, or exchange an expiring single-use bootstrap claim
for an explicitly specified administration credential. Keep it separate from
the installation setup claim and Kernel credentials. Store authentication
secrets hashed and make disclosure deliberate local output, outside ordinary
deployment/CI logs. Recovery must remain possible through deployment ownership
when the original output is lost.

**Acceptance addition:** repeat deployment and interrupt bootstrap without
creating another first installation, reissuing consumed setup claims, or
silently rotating operator access. Test setup expiry/reissue and operator
credential recovery.

### R5. Keep removal behind its stated gate

**Required for W3/W7 and section 5.** W3 currently removes `standalone.ts` and
`GsvRuntimeMode`; W7 promises to remove them only after adoption and isolation
validation. Move those removals to W7. W3 can establish the common composition
and its required directory while the legacy entrypoint remains supported until
the announced cutover.

Also remove the claim that W1–W3 have no user-visible behavior changes: human
admission, invitations, and membership revocation change authentication. State
their rollout and existing-credential compatibility explicitly. Tag the last
verified working standalone release before changes make that deployment
unusable, and list any public API renames that require coordinated consumers.

### R6. A shared external space does not identify one installation

**Required for W5.** The ownership layers correctly say a workspace/server
installation carries no GSV installation. The later rule that "the space
resolves the installation" contradicts that and prevents colleagues in one
Slack workspace from using separate GSV installations.

The current Slack peer is scoped by adapter account and actor
(`workers/adapters/slack/src/managed-identity.ts`); that peer's authorized link
selects the installation and local uid. Keep space plus actor as the routing
scope for shared spaces. For DMs without a space, define the scope using the
operator's adapter application/bot and external actor, rather than a provider
identity globally across operators. Specify how Discord's DM route coexists
with server-scoped links.

Only the signed-in human's confirmation may choose the destination through
trusted Kernel context. A provider webhook or pairing code cannot choose it.
Moving a link must fence the old route immediately; notifying the previous
installation is cleanup, not the security boundary.

**Acceptance addition:** two people in the same external workspace reach
different installations. Moving one link rejects delayed ingress and delivery
from its old generation without changing the other person's route.

### R7. Exercise routing at both the adapter and gateway boundaries

**Required for W5/W6.** The useful invariant is that an admitted delivery reaches
exactly one authorized installation. Unknown, unpaired, revoked, ambiguous, or
inactive destinations must reach none. A Kernel-only test cannot prove that a
public adapter webhook never selected the wrong Kernel before that point.

Use a reusable integration suite covering adapter ingress, gateway admission,
and delayed outbound delivery. Include invalid provider authentication,
unpaired identities, unknown hostnames, restricted installations, retries,
re-pairing, and membership revocation. Verify rejection before ordinary Kernel
work, and that gateway authorization enforces what inventory advertises.
Provider-specific fixtures should exercise each adapter's actual identity scope.

The real-cloud adoption and fresh-account runs remain release gates; keep the
repeatable contract tests in normal CI. A public test runner may create and
destroy only its explicitly provisioned fixtures. W6's destructive fresh run
must remain separate from H&M adoption verification.

### R8. Preserve stored names as well as Alchemy resource identities

**Required for W2/W4/W5.** Existing-name exceptions must include stored protocol
and state identifiers. Examples include `managed_telegram_pairing:v1`,
`managed_slack_pairing:v1`, Telegram's `managed` account id, link metadata
`managed: true`, and the `managed-shared` route mode. Renaming only their
readers can orphan state without replacing any Cloudflare resource.

Inventory persisted values, Durable Object namespaces/names, exports, binding
names, and service consumers before renaming. Keep an explicit compatibility
mapping or migrate each item deliberately. New public vocabulary can be neutral
while adopted storage retains its historical spelling.

**Acceptance addition:** existing links, pending pairings, queued deliveries,
and retry receipts continue working after adoption without requiring people to
pair again. Compare these behaviors as well as Alchemy state identifiers.

### R9. Make reset semantics part of the acceptance criteria

**Required for W1/W6 and section 6.** Distinguish Process history reset from
operator installation reset. The latter already allocates a fresh installation
id, moves the handle, and retains the old identity behind inactive routing
until each data owner completes cleanup. "Existing installations keep their
identities" needs this deliberate reset exception.

Specify which memberships and adapter links are invalidated or explicitly
re-established for the replacement installation. Reusing a hostname must not
make old invitations, credentials, routes, or delayed work valid for the new
installation.

**Acceptance addition:** verify the fresh reset identity, inaccessible old
identity, stale-work rejection, and retryable cleanup after a simulated owner
failure, while the other installation remains usable.

### R10. Measure removal by executable behavior

**Clarification for W7.** Repository-wide zero matches for "standalone" and
"singleton" would also reject this specification and legitimate terminology.
For example, `kernel/auth-store.ts` mentions standalone Unix groups; that is
unrelated to hosting.

Require removal of the executable legacy hosting paths and maintain a reviewed
allowlist for historical migrations, design records, and unrelated comments.
Keep relevant isolation/security regression tests when deleting compatibility
tests. Include ripgit's legacy installation addressing and every actual
protocol/deployment consumer in the cutover inventory.

### R11. Tighten optional-service and scope claims

**Acceptance clarification for W3/W6; wording for section 7.** Keeping the
Workers AI base stack matches `inference/base-model-stack.ts`. A successful
conversation alone does not prove that a supplied provider credential worked:
fallback could have produced it. Assert the actual responding provider/model
and credential source without exposing the credential. Document that any
Workers AI fallback uses the operator's resources.

Keep the own-hardware work explicitly unestimated; "small local stand-in" is
not established by this extraction. Likewise, packaging the web shell,
generalizing prompts/skills, and committing to a framework SDK are not automatic
outputs of hosting consolidation. Retain existing extension points and defer
additional framework work until a concrete operator requires it.

## 10. Resolution of the review (revision 3)

Every point was checked against the code and accepted as written. Where a
point asked for a decision, the maintainer decided, and two of the review's
premises were removed rather than satisfied on those decisions: there is no
private family of tables, and there is no human admission at the directory.
Section 11 is the author's response to the reviewer on what remains, so the
two of us can settle it before anything goes back to the maintainer.

| Point | Resolution |
|---|---|
| R1 | Premise removed: humans sign in to installations by Kernel credentials, never to the directory; the directory provisions and records the owner principal. The backfill concern is met in W1c by the Kernel's trusted report while root is signed in. Revocation is root's Kernel operation on the local account (W1b). |
| R2 | Vocabulary corrected: machines hold peer credentials and are not local accounts. Human invitations live entirely in the Kernel (W1b): consumption and account creation are one atomic, idempotent operation; no cross-system receipt exists. Purpose, installation, issuer, and enrollment are fixed at mint. Acceptance additions adopted. |
| R3 | `principals` added. Decided: the inference service is public, so both owners are public workers on one operator database with separate migration ledgers; inference foreign keys dropped so its tables reference installations by id and can move later; `role` dropped by migration; the one cross-owner join becomes a call; policy projects into `trialing` and `past_due` with the work gate active-only. Acceptance covers the adopted and the fresh database. |
| R4 | Bootstrap claim and operator credential separated; the credential is hashed, disclosed once as deliberate local output, rotatable, revocable, recoverable by redeploy with an explicit rotate flag. Idempotent redeploy and interrupted bootstrap in acceptance. |
| R5 | Removal of `standalone.ts` and `GsvRuntimeMode` moved to W7. The "no user-visible change" claim narrowed; the last standalone release is tagged before any change makes it unusable; renames requiring consumers are inventoried in W4. |
| R6 | The "space resolves the installation" rule withdrawn. Scope is operator application plus space plus actor in shared spaces, operator application plus actor in DMs; the actor's link selects installation and uid; only the signed-in human chooses; a moved link fences by route generation. Acceptance additions adopted. |
| R7 | W6 gains the contract suite in CI with the exactly-one-or-none invariant across adapter ingress and gateway admission; real-cloud runs remain release gates; the fresh run is destructive only to its own fixtures. |
| R8 | W4 gains the naming inventory with the listed persisted identifiers and the acceptance that links, pairings, deliveries, and receipts survive adoption. |
| R9 | W6 distinguishes Process history reset from installation reset and states what is invalidated and re-established; invariant 3 carries the reset exception. |
| R10 | W7 acceptance measured by executable behaviour with a reviewed allowlist; isolation and security regression tests kept; ripgit's legacy addressing and every consumer inventoried. |
| R11 | W3 acceptance asserts the responding provider, model, and credential source; Workers AI fallback documented as the operator's resources; own hardware stated as unestimated; framework seams described as retained. |

## 11. Author's response to the reviewer (revision 3)

For Astra. These are the points where I want your check or your
disagreement before the maintainer sees a final text. Reply in place under
each item; what we settle here stays here, and only what we cannot settle
goes to the maintainer.

### A1. Root reset is the new most powerful operation. Is its authentication right?

W1b layer 3 lets the directory ask the Kernel for a one-time root credential
reset. I have specified it as authenticated as the directory (the service
binding the gateway already trusts for `resolveInstallation`), scoped to the
installation the directory resolved for that hostname, single-use, and
ledgered. What I want from you: is service-binding identity sufficient, or
should the Kernel additionally require a claim the directory minted and the
owner redeemed, so that a compromised directory alone cannot reset root?
My inclination is the second, at the cost of one more single-use claim.

**Astra reply, 2026-09-11 — agree with a redeemed claim, correct the trust claim.**

A claim minted by a compromised directory does not protect against that
directory: it can mint and redeem the claim itself. Expiry, single use,
recipient binding, and an explicit redemption step are useful controls, but
they do not create an independent source of authority.

My recommendation is to state that the directory is trusted for owner
recovery, after fresh authentication of the recorded owner principal. Use a
short-lived claim scoped to the immutable installation id, root credential
reset purpose, and recovery attempt; let the owner redeem it at that
installation. The Kernel owns consumption and credential replacement,
including the defined policy for revoking previous root credentials. Reject
claims for a retired installation even if its hostname now resolves to a
replacement, and ledger outcomes without the secret.

The existing `INSTALLATION_DIRECTORY` binding is an outbound capability from
gateway to directory. It does not establish authority for a new incoming
reset call. Define an explicit gateway recovery entrypoint whose binding is
granted only to the directory, with deployment-owned authority, separately
from adapter entrypoints and public requests. Do not trust a request field
that says it came from the directory.

If protection from a compromised directory is a requirement, the Kernel
must verify an independent factor already bound there, such as an
owner-held recovery key. That is a different recovery policy, including what
happens when the factor is lost. The one remaining product decision here is
whether directory-authenticated ownership is sufficient recovery authority;
the extra directory-issued claim cannot decide it for us.

### A2. Ownership without `local_uid`

With owner as root, `local_uid` on ownership rows is always 0. I propose
dropping the column with `role`, in the same W1a migration. If you see a
future use that argues for keeping it null, say which.

**Astra reply, 2026-09-11 — agree.**

Drop `local_uid` with `role` in a forward migration and update the existing
provisioning/reset SQL that writes those columns. A directory ownership row
does not need a speculative Kernel uid. This does not renumber any local
account or change a person's ordinary credentials.

W1c must prove both sides of the link: authenticated root of this
installation and the verified external principal being linked. Root
supplying an arbitrary principal id or email is not proof of that
principal's identity. Update `installations.owner_principal_id` and its
ownership row atomically, and do not enable owner recovery for an
installation still attributed to the shared registry principal.

### A3. One operator database, two public owners

Your R3 assumed a database per owner. With both owners public, I have kept
one database and dropped the inference foreign keys so the tables can move
later. The reasons you might still want the split, least privilege between
the two workers and the unbounded growth of usage events next to the
directory, are real; I have judged them not worth moving data during
extraction. If you weigh them differently, give the number at which usage
events force the move and we will write that trigger into W2.

**Astra reply, 2026-09-11 — accept one database; make the extraction concrete.**

R3 required explicit ownership and an adoption plan, not necessarily separate
databases. With inference now public, one operator D1 is a reasonable first
deployment. Separate migration ledgers establish migration ownership, not
table-level access isolation between workers sharing the binding. I would
not invent a usage-event count at which a split becomes mandatory: row size,
retention, write rate, and query cost matter. Track database headroom and
directory latency; revisit isolation if the operator requires it or measured
usage growth threatens those budgets.

Two corrections are still needed in W2:

- There is more coupling than the admin panel. In the current services
  repository, `accounts/src/inference-policy.ts:resolve` joins installation
  state into inference admission, and `setInstallationPolicy` selects from
  installations. `accounts/src/store.ts:resetInstallation` copies and
  disables inference policy inside the reset batch. Move these responsibilities
  to explicit owner contracts too. Preserve active-only admission and give
  reset policy transfer/cleanup durable, idempotent completion; removing
  foreign keys alone does neither.
- Name the migration handoff. Inventory each historical migration and its
  owner; copy shipped SQL unchanged, and reconcile the adopted database's
  applied records into the new owner ledgers without replaying DDL. Specify
  fresh-install ordering, optional inference enablement later, and resumable
  adoption. Do not point two empty ledgers at the entire old history. Test
  interrupted handoff as well as fresh inference-disabled deployment and
  later inference enablement. Physical names may stay historical under W4's
  mapping; neutral source names do not require a simultaneous table rename.

Also, the current policy resolver reads installation state; it does not
project allowance policy into `trialing` or `past_due`. Keep those public
schema values as decided, but remove the claim that this projection already
exists. Any new lifecycle transitions need an explicit contract and tests.

### A4. The contract suite's minimum

R7 asks for a suite across adapter ingress, gateway admission, and delayed
delivery, with provider fixtures. I agree with the invariant and want the
smallest suite that proves it in CI. Propose the minimum case list per
adapter that you would accept as the gate for W7, so it is bounded before
anyone builds it.

**Astra reply, 2026-09-11 — six shared scenario groups per adapter.**

Run these through each adapter's actual ingress/routing code and gateway
admission, with provider fixtures and controlled delayed delivery. The
required adapters at cutover are Telegram, Slack, and Discord; each enabled
ingress mode gets the applicable variants below.

| Case | Minimum assertion |
|---|---|
| Provider proof and unpaired actor | Invalid provider authentication and a valid but unpaired actor select no Kernel. Public payload fields cannot supply an installation id or local uid. |
| Pair confirmation and replay | A signed-in human's authorized confirmation fixes the route. An unauthorized confirmation cannot bind it; a lost-response retry recovers the same result and a consumed code cannot establish another route. |
| Two installations | Two actors under one application reach their respective installations, with colliding local usernames/uids. For Slack and Discord, include both actors in one external space and exercise their supported DM scope separately. |
| Admission revoked | Restrict the installation, revoke the local account, or disconnect the link between receipt and admission. Each variant refuses ordinary work; the other actor remains usable. |
| Relink with work in flight | Move one actor to another installation while ingress and outbound delivery are delayed. Both stale operations fail their generation check; stale cleanup cannot remove the new link; the other actor's route survives. |
| Provider retry and delivery outcome | Duplicate inbound provider events do not admit duplicate work. A safely retryable send retains its delivery identity and destination; an ambiguous provider acceptance follows the adapter's ambiguity policy rather than blindly duplicating delivery. |

Run unknown/wildcard-host rejection once at the shared gateway boundary,
asserting no Kernel allocation. Run installation reset with hostname reuse
and deletion-cleanup retry once through the shared lifecycle suite, asserting
old credentials/claims/routes cannot reach the replacement and the second
installation remains usable. Keep the fresh/adoption cloud runs in W6.

Instrument both destination selection and admission. Invalid authentication,
unknown hosts, and unpaired actors must be refused before Kernel selection;
local-account authorization necessarily consults the selected Kernel but
must refuse ordinary work. A Kernel-only counter cannot prove both facts.
No real inference calls are necessary for this contract suite.

### A5. The cutover statement

R5 asks for existing-credential compatibility to be explicit. With people
living in Kernels, existing web sessions, CLI credentials, and adapter links
are untouched by W1; the only credential change is additive. Confirm that
satisfies R5, or name the credential you think is still affected.

**Astra reply, 2026-09-11 — yes, with the account distinction explicit.**

Current setup creates the ordinary human account separately from root
(`workers/gateway/src/kernel/sys/setup.ts`). It sets a custom root password
when supplied, otherwise root initially receives the human's password.
"Owner is root" must mean administrative authority through that existing
root account, not converting the ordinary human uid to 0, moving their home,
or relinking their agents, sessions, machines, or messengers.

With that interpretation, W1 is additive. Preserve existing root and human
credentials on upgrade; ownership linking alone rotates neither. Password
reset and account removal change access only when explicitly invoked, with
their revocation behavior tested. Include an upgraded installation with an
existing web session, CLI credential, machine credential, and adapter link
in acceptance, alongside fresh enrollment.

Passkeys are new implementation work, not an existing login capability. Give
them their own credential enrollment/revocation and compatibility acceptance;
they can be a separate stream without making public service extraction wait
for a new default sign-in method. Define invitation retry identity as well:
an unauthenticated invitee has no existing account, so "same recipient" needs
a redemption proof bound on first consumption; possession of the invite
alone must not let a later redeemer replace the new account's credential.

### A6. Renames with consumers

R8's inventory covers persisted identifiers. The public API renames that
need coordinated consumers are, as far as I can see, the `Managed*` service
binding names and the `managed-shared` route mode's readers in the CLI and
Desktop. If you know of others, add them here so W4's inventory is complete
before the move.

**Astra reply, 2026-09-11 — add these verified consumers to W4.**

- Public SDK types and exports: `packages/gsv/src/services/{directory,onboarding,inference,mail}.ts`,
  `protocol/managed.ts`, and `protocol/managed-inference-stream.ts`. This
  includes installation identity types and stream readers/writers, not only
  service binding names. The separately pinned services repository must move
  with the contracts it implements.
- Actual RPC method names: for example `getManagedInferencePolicy`,
  `recordManagedInferenceUsage`, `acceptManagedInboundMail`, and
  `unlinkManagedAdapterIdentity`. Callers and Worker entrypoints need a
  coordinated deployment; a TypeScript alias alone does not rename an RPC.
- Deployment manifests and their consumers: `deployment/src/manifest.ts`
  has `standalone`/`managed` variants; adapter JSON files name Worker
  entrypoints, DO classes, and binding names such as `ManagedSlackChannel`
  and `MANAGED_TELEGRAM_PEER`. Include bundle generation, Wrangler configs,
  generated environment types, the overlay, and
  `scripts/check-managed-deployment.sh` in the cutover inventory.
- Web feature detection: `web/src/app/features/instrument/settings/messengers/messengerPresentation.ts`
  reads `managed-shared` to decide which connection UI is available, and
  gateway `kernel/adapter-pairing.ts` produces it. I did not find a literal
  reader of that value in the current CLI/Desktop sources; inventory their
  actual protocol/deployment dependencies rather than assuming they own this
  particular branch.
- Mail is an optional service consumer too: the email worker and gateway
  use the managed mail contracts and `MANAGED_MAIL_OUTBOUND`. Account for
  that deployment and its durable pending work even though messenger
  alignment is focused on Telegram, Slack, and Discord.

For each item record producer, consumers, persisted representation if any,
and rollout/removal order. Retaining a stored value or temporary callable
alias must correspond to that concrete compatibility window. DO class and
resource adoption cannot be inferred from a successful source rename.

## 12. Maintainer decisions after revision 3

### Accounts is trusted for root recovery

Decided by the maintainer, 2026-09-11. Accounts is a core authority in the
consolidated architecture. Its directory and ownership functions authorize
root recovery after authenticating the installation's verified owner
principal. A1's authority question is closed; this work does not require an
additional owner-held recovery key.

The Kernel still owns the credential change and consumes a short-lived,
single-use reset claim for its immutable installation id through the
explicit trusted recovery contract. An ordinary account, adapter, or public
request cannot invoke that authority. Claim handling prevents replay and
cross-installation use; Accounts itself is trusted to authorize recovery.

### Complete installation data deletion belongs in consolidation

Accepted scope for W2 extraction and W6 validation. "Deletes as before" is
not sufficient acceptance: the current Accounts reset operation creates a
replacement installation and records the old identity's
`data_deletion_state` as `pending`. The current service exposes that status
but has no implementation that advances the operation through erasure to
completion. Existing pending resets must be handled by the new deletion
path as well as future resets and explicit installation deletion.

Accounts owns a durable deletion operation, scoped to the immutable
installation id. Each service owns deleting its own data through an
authenticated, idempotent lifecycle contract. This contract applies to
public reference services and private operator implementations alike.

The operation must:

1. Close ordinary admission and revoke routes and credentials for the old
   identity. Quiesce or cancel its active work and fence delayed writes,
   alarms, retries, and deliveries before acknowledging erasure.
2. Retain the inventory needed to locate every owned resource until its
   owner confirms deletion. In particular, deleting the Kernel's process
   and conversation directories first must not strand their Durable
   Objects. Include formerly enabled services that still hold data.
3. Delete data in bounded, resumable batches and persist each owner's
   progress. A timeout, lost response, or temporarily unavailable owner is
   retryable; it does not mean deletion succeeded.
4. Mark the operation complete only when every data owner has confirmed
   erasure. Keep only the minimal content-free deletion record needed to
   reject stale work and explain completion. Expose progress and a retryable
   failure instead of leaving an unexplained pending row.

The ownership inventory must cover:

| Owner | Installation data to erase |
|---|---|
| Kernel | Local accounts, credentials, configuration, permissions, schedules, responsibilities, ledger, contacts, links, and pairing/setup/recovery claims. |
| Processes and conversations | Every owned Durable Object's state, history, traces, message records, pending work, and related archives. Killing a Process alone does not erase its canonical conversation. |
| Storage and repositories | Installation-scoped files, immutable resource revisions, media, archive objects, incomplete uploads, and ripgit repository state. |
| Adapters and mail | The installation's identity links, pending pairing records, queued payloads, deliveries, and retry receipts. Shared application credentials, other installations' links, and a newer route generation remain intact. |
| Inference and commercial services | Installation policy, reservations, request state, per-installation metering objects, and detailed usage records, including private implementations. |
| Accounts | Installation-specific ownership, hostname, onboarding, and operation data beyond the minimal deletion record. Preserve a principal's other installations and their records. |

Inventory operator-controlled telemetry, provider logs, caches, and backups
too. Specify their deletion or expiry mechanism and report any remaining
retained data explicitly; absence from the live application's tables alone
must not be reported as complete erasure. This operation targets data held
by the deployment and its services; it does not erase another person's
conversation copy or files on a connected machine.

W6 adds a populated two-installation test with matching usernames and paths.
Reset or delete one, interrupt an owner cleanup, resume it, and verify all
inventoried application stores are empty for the retired identity. Replay
delayed work after completion and verify it recreates no user data. The
replacement and the second installation remain usable. The adoption run
also exercises a pre-existing `pending` deletion record using staging
fixtures, without turning adoption itself into a production purge.

These are internal slices of the single hosting-consolidation workstream.
Independent production fixes, including generation reliability in
[#308](https://github.com/deathbyknowledge/gsv/issues/308), continue in their
own workstreams and are incorporated into the extracted services.
