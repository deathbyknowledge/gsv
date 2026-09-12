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
public `3c65ead6` and private `8a2b01fb`. These are the exact historical-upgrade
pins; the separate delayed-response fixture below used a later runtime.

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

### Completing the inherited pending reset

A subsequent run completed that genuine pending reset's live cleanup at
23:11 UTC, through Accounts and the existing owners. It retained the original
reset and private inference preparation until the coordinator erased them.
No new reset, credential issuance, explicit generation or manual SQL deletion
was used.

Fresh capture accounted for all 31 stored objects across six namespaces. Its
first attempt stopped with eight unidentified legacy objects. Saved Process
identity and repository names were then checked by their actual namespaces
against the listed physical IDs; a new complete capture identified every object.
Nine captured resources belonged to retired A. A tenth, separately derived
native Executor address was included in direct verification without claiming it
was previously populated.

Registration, start, completion and verification ran as four separate processes.
All four owners reached `live-erased` with zero pending resources. Two fresh
physical reads found no application data at the ten pinned addresses, and the
old R2 prefix and multipart listing were empty. Owning cleanup removed the old
directory, reset, participant, private preparation, policy and usage rows.
Migration ledgers and foreign-key checks remained valid.

B and the replacement retained their full saved histories, identities, marker
files and policies. Ten saved human/root and web/CLI/machine credentials authenticated;
all five retired-A credentials received actual 401 rejections at the replacement
address. Reconnect-generated history was recorded separately, after the strict
history comparison. This closes the isolated inherited-reset live-data case.
Platform backups remain retention-pending; native provider and AI Gateway
retention still have no verified expiry.

## Delayed native response after live cleanup

A separate disposable `gsv-delay-fa219c8e` stack used public runtime `4dcf1c01`
and the [stream acceptance helpers](../deployment/acceptance/delayed-inference/README.md).
One real Process request completed through native Workers AI with
`@cf/zai-org/glm-5.3-flash`: terminal `toolUse`, 237 output tokens. The relay
held that original response while A was reset and its retired identity cleaned
up. It observed the Gateway's actual cancellation before the original deadline.
All four configured owners reported `live-erased`, with zero pending resources,
for the saved deletion operation before release.

The same original writer attempted the held response at 21:54:34.569 UTC,
65.728 seconds before its unchanged deadline. Its write and close **succeeded**;
the original driver's stronger writer-rejection requirement therefore remains
**inconclusive**, with its failed receipt preserved. A successful transport write
does not establish Process acceptance. No inference request was replayed, and
the original Gateway, Inference, relay, controller, writer and lease were not
redeployed or replaced during the attempt.

Independent fresh reads found no application data at all ten original physical
addresses: Kernel, Process, Conversation, the original InferenceExecutor and
six repositories. The original R2 prefix was also empty. These checks ran before
release, at 21:55:28.802 and 21:55:34.380 UTC after release, and at
21:56:16.445 UTC after the original 21:55:40.297 deadline. The last read used a
separate inspection deadline; it did not extend the inference request. B's full
conversation history and distinct marker, and the replacement's credentials
and data, remained intact. Old credentials were rejected at the replacement.

The read instrument required one correction: its first lifecycle inspection
omitted the contract's `version: 1` and failed closed with HTTP 409. An explicitly
approved temporary authenticated Worker corrected only that read request, using
the same ten addresses and five namespace bindings. It was removed after the
checks. This diagnostic continuation did not replace the original relay or
convert either failed driver receipt into a pass.

The final account inventory passed 15 preservation checks: all 22 selected
fixture resources and their configurations remained, the temporary diagnostic
Worker and route were gone, and no unrelated resource changed. Accounts accepted
one scoped operator attestation clearing the relay's captured buffer; a fresh
authenticated read confirmed it. Native provider retention and AI Gateway
logs/cache remained explicitly `unknown`.

These observations support no application-state resurrection from this one
original delayed native response and exercise the native inference owner with a
real request. The captured stored-object inventory identified nine Gateway-owned
objects for retired A; the known original executor address was checked separately
in the fixed ten-address probe scope. This does not establish a populated, persisted executor
history before cleanup. These checks do not prove transport
rejection, messenger delivery behavior, commercial inference-history cleanup,
or final erasure of retained backups, provider data and caches. Tombstones remain
explicitly excluded from live-data counts. The original strict result and the
separate before/after receipts remain in private operator evidence under
`delayed-native-20260912`; no message body or credential is published here.

## Populated Mail acceptance

The disposable delayed-response stack was extended with the real public Mail
owner and two additional synthetic spaces. The original spaces, resource
identities, Worker modules and four-owner cleanup receipt were preserved. Only
the two new immutable identities were admitted by the private test intake.

Each space stored exactly one synthetic RFC822 message through the real inbound
Mail handler. The raw MIME and rendered text matched the saved content hashes.
Both agents remained idle, with unchanged Process and Conversation histories
and responsibility ledgers. Summarization was deferred with zero attempts;
there were no outbound attempts. The fixture has no SMTP route, outbound queue
or inference binding, so this establishes Mail storage behavior rather than
external delivery.

The first test stopped because its driver tried to read the binary MIME file
through the text-only read operation. The binary transfer syscall returned the
expected bytes. After correcting that driver, verification recovered the
already stored A message before sending B's message; A's intake was not replayed.
The final deployment comparison passed all 179 checks. A was reset to a fresh
identity, old passwords were rejected, and B retained its stored Mail and quiet
history. Cleanup is awaiting a complete inventory: scans omitted the known
initialized replacement Kernel and Process even when their before/after object
lists matched. Those scans are retained as incomplete evidence and have not
authorized deletion.

## Remaining release coverage

The live reset/cleanup result does not replace the other cases in
[W6](hosting-consolidation-spec.md): real Telegram linking and delivery for two
controlled actors, BYO model credentials, and the remaining populated service
owners and delayed adapter work. The native response case above provides
qualified live-state evidence without completing those other cases. H&M staging
resource adoption and migration ownership
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
