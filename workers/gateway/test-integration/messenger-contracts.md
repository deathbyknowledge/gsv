# Composed messenger contracts

`messenger-admission.test.ts` exercises the W6 contract with real Telegram,
Slack, and Discord Workers, their actual Durable Objects, the real Gateway,
and real Kernel/Process admission. It uses synthetic provider APIs and the
existing directory/onboarding/inference fixtures; it requires no commercial
credentials or external inference.

The wire fixture forwards every frame unchanged to the real implementation.
It can delay a frame or lose a completed pairing response, and records both
destination selection and the actual Gateway result. A passing admission
assertion also finds the exact run receipt and Process owner in that Kernel's
SQLite storage. Recording a selected destination alone is never success.

| W6 group | Composed assertions |
| --- | --- |
| Provider proof and unpaired actor | Bad webhook proof or wrong Discord application identity, and valid unpaired ordinary messages with forged routing fields, allocate no Kernel. Unknown wildcard hosts are checked separately. |
| Pair confirmation and replay | An unauthenticated socket cannot confirm; a signed-in human can recover a lost finalize response; another space cannot reuse the consumed code. |
| Two installations | The same username and uid in two spaces remain separate. Slack and Discord exercise both DMs and two actors in the same external room. |
| Admission revoked | Restriction, account removal, and link disconnect happen after adapter destination selection but before real Gateway admission; no run is admitted and the other actor still works. |
| Relink with work in flight | A positive outbound control succeeds first. Held inbound and outbound frames from the old generation are then rejected after relinking. Old-space disconnect cannot remove the replacement link, and both actors remain usable. |
| Provider retry and outcome | Duplicate provider events create one durable run receipt. A definite rate limit can retry the same delivery identity and destination; accepted-but-unreadable provider responses remain ambiguous and are not resent. |

Existing provider suites retain their focused media, provider-session,
delivery-ledger, and retirement race tests. This composition complements those
suites; it does not replace the fresh-account and H&M adoption cloud gates.

Run after building the SDK and web assets:

```bash
cd workers/gateway
npx tsc --noEmit -p tsconfig.integration.json
npx vitest run --config vitest.integration.config.ts test-integration/messenger-admission.test.ts
```
