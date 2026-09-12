# Hosting consolidation: cloud acceptance, September 12

This records observed results, not completion of every W6 release gate. The
personal-account fixtures use the public deployment package. Production and
H&M staging were not changed during this acceptance run.

## Fresh-space reset and cleanup

The guarded [lifecycle driver](../deployment/cloud-lifecycle-acceptance.md)
completed preparation, seeding, reset, replacement setup, isolation verification,
retirement and live cleanup. Only its recorded fixture A was reset. Fixture B
and three other existing spaces were preservation controls.

- A's public address moved to a fresh immutable identity. A's same-path marker
  was absent before the replacement's own marker was written. Its new human/root
  passwords worked; the old human/root passwords were rejected.
- B's passwords, same-path/different-content marker and complete conversation
  fingerprint remained unchanged. The other three directory identities and
  states remained unchanged.
- Matching Cloudflare enumeration before and after ownership inspection covered
  all 60 stored objects in the five configured namespaces, before cleanup.
  Nine belonged to retired A: one Kernel,
  one Process, one Conversation and six repositories. There was no previously
  populated InferenceExecutor for A; this is not a populated inference-history
  erasure test.
- Two earlier captures stopped when the listing changed. A third passed after
  the replacement's objects appeared. Every previously new object was identified
  as replacement-owned. No completeness check was bypassed.
- Accounts verified and imported the exact captured inventory. A temporary
  service relay ran the real Gateway cleanup and lost its acknowledgement.
  Accounts recorded `retry`; after restoring the normal binding, the same
  operation resumed successfully. The relay was removed. No fault remains.
- Direct S3 enumeration found zero completed objects under retired A's prefix.
  B and the replacement each retained five objects, and the driver rechecked
  their file contents and credentials.
- A's synthetic unfinished multipart upload was aborted, followed by a fresh
  empty enumeration. B's original upload and expected part survived. Only after
  that preservation proof was B's exact synthetic upload removed; no other
  upload was aborted by that cleanup.
- Accounts accepted the multipart evidence. All four configured owners then
  reported `live-erased`, with zero pending live resources. The old directory
  row and reset linkage were removed while the replacement remained usable.

The operation deliberately remains **retention-pending**, not fully erased.
Accounts, Gateway and Inference retain their declared platform backup windows.
Accounts recorded a conservative seven-day policy for Gateway and Ripgit's
native Workers Logs, expiring September 19 at 17:52 UTC. This uses
[Cloudflare's documented maximum](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#limits)
and fresh Worker settings, without assuming a billing tier or claiming that
historical exports are absent. Workers AI provider retention and AI Gateway
logs/cache still have no verified expiry or absence proof. The personal API
token receives HTTP 403 for AI Gateway settings. Unknown retention was not
converted into an empty-store claim.

The native Workers AI limitation is separate from API permissions: its
[data policy](https://developers.cloudflare.com/workers-ai/platform/data-usage/)
restricts training use but supplies no finite retention guarantee, and its
[prompt-caching documentation](https://developers.cloudflare.com/workers-ai/features/prompt-caching/)
does not specify a maximum cache lifetime. Disabling AI Gateway log collection
does not establish upstream provider erasure.

The capture, immutable evidence, credentials and operation receipts remain in
private operator storage. No credentials, message bodies or file contents are
included here. The runtime and web module bytes were unchanged; the live
deployment change added the explicit operator deletion catalog, followed by the
temporary, subsequently restored lifecycle binding.

## Observed R2 upload identifiers

Repeated R2 `ListMultipartUploads` calls returned different opaque upload ID
strings for the same controlled upload. Hashes of listed IDs are useful capture
evidence, but did not identify this upload consistently across captures.

The original initiation ID still resolved through `ListParts`, twice, and a
newly listed alias resolved to the same part number, size, checksum and timestamp.
B's 24-byte synthetic part was unchanged; A's original ID returned
`NoSuchUpload` after cleanup. The preservation check and subsequent B cleanup
therefore used the original saved key and upload ID. This is observed provider
behavior, not an asserted guarantee about the encoding of opaque identifiers.

## Historical upgrade acceptance

A separate `gsv-upgrade-5de18320` deployment on the personal account completed
the old-to-new upgrade at 18:11 UTC. It used genuine pre-extraction public
`6915d5e6` and private `3777be4b` sources, then adopted the same resources with
public `3c65ead6` and private `8a2b01fb`. Later public changes add acceptance
tooling and reports; they do not change those runtime artifacts.

The old implementation created two spaces, issued their credentials and
performed a real reset with durable inference preparation and pending deletion.
The handoff removed its migration runner, froze D1, saved a reviewed snapshot
and survived a separate-process status check. Applying the exact approved
snapshot and replaying that apply produced the same released receipt. Nine
forward migrations completed through the new owners; the twelve-entry legacy
ledger remained unchanged, all 21 migration sources matched, and foreign-key
checks were clean.

The current deployment passed 63 module, binding, resource and schema checks,
followed by 33 credential/state checks. Both spaces retained their original
human/root passwords and web/CLI/machine protocol tokens, isolated contents at
the same file path, and Process/Conversation identities. Retired A's old
password and token remained rejected at the replacement address. Its existing
pending deletion and preparation survived; this test did not initiate a purge.

The full saved history prefixes also survived: one committed user message and
six typed Process records, including a real inference error, with no edits,
removals or reordering. Verification sent no new explicit messages. Inference
was disabled and the stack contained only deployment-base GSV entries; zero
external inference requests is derived from that checked execution path, not
from provider telemetry. The test does not claim a generated assistant reply
or populated commercial usage history.

The [repeatable harness](../deployment/acceptance/legacy-upgrade/README.md)
has 21 focused tests and a CI typecheck. Its operator admission is synthetic;
the machine check reconnects a protocol fixture, not physical hardware.
Cloudflare Access and existing messenger-link continuity remain separate
coverage. These fixture resources are retained for inspection. H&M staging
and production were not changed by this acceptance run.

## Remaining release coverage

The live reset/cleanup result does not replace the other cases in
[W6](hosting-consolidation-spec.md): real Telegram linking and delivery for two
controlled actors, BYO model credentials, populated inference/adapters and delayed
work after deletion. H&M staging resource adoption and migration ownership
handoff were completed earlier; remaining adoption evidence concerns older
client credentials, messenger links and authenticated operator admission.
Its controlled human/root passwords were verified across later rollouts, but
that fixture was created after extraction and had no earlier client tokens or
messenger links. Those historical checks are recorded in the workstream notes;
their original temporary receipts are no longer available for re-inspection.

Retained-copy evidence also remains open. The completed isolated upgrade
supplies genuine historical client/history and migration recovery evidence;
it does not replace the remaining H&M admission and messenger-link checks.

W7's executable standalone removal remains gated on that coverage and a last
verified standalone release. This report does not authorize a production
deployment or change those gates.
