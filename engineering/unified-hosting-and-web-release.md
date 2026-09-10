# Unified hosting and web release

Recorded 2026-09-10 from the maintainer's hosting and web UI discussion.

This is the agreed direction and release plan. It describes future work; the
current runtime still supports managed and standalone deployments. Update the
engineering contract and architecture references when the cutover is implemented.

## Decisions

- Finish and release the new Instrument web UI first, against the current managed
  runtime. Retire the old desktop UI once retained workflows have replacements.
  Keep UI batches small and check in with the maintainer before expanding them.
- Use Instrument's routes for the web cutover. The maintainer explicitly waived
  compatibility for existing deep links; no legacy route mapping is required.
- Then make one hosting model: an operator deploys GSV to their own Cloudflare
  account and can create one or several isolated installations. H&M runs the same
  public core. Multiple installations do not imply open public registration.
- An installation owns its local accounts, agents, state, credentials, machines,
  and linked identities. Operator administration remains separate from local
  account administration, even when one person performs both roles.
- The maintainer reports practically no active singleton self-hosting. Prefer a
  documented breaking cutover to a general automatic migration system. Identify
  actual remaining installations, preserve a last standalone release, and agree
  individual data recovery or migration where needed. Do not infer activity from
  the legacy hostname exclusions alone. Existing managed installations retain
  their identities and data.
- Configure provider applications at deployment/operator administration time.
  People still authorize and link their external identities at runtime. Enabled
  adapters behave the same regardless of who operates the deployment.
- Use the official WhatsApp Business Platform/Cloud API for the future operator
  WhatsApp transport. The maintainer accepts the restrictions described below.
  This adapter is a separate follow-up and does not block the UI or hosting work.
- The maintainer plans to work on an iMessage solution for US users later. It is
  outside the current implementation batch.
- Leave the Send-tool proposal aside. This plan does not change Send semantics.

## Licensing

No license change has been requested. GSV remains MIT. The recommendation is to
retain MIT unless reciprocal availability of hosted modifications becomes an
explicit product goal. AGPL is an option for that goal, but also allows commercial
hosting. Decide the license for currently private operator components before
publishing them, and review contributor and dependency rights if changing terms.
Already released MIT versions remain available under their existing license.

References: [MIT](https://opensource.org/license/mit) and
[AGPL](https://opensource.org/license/agpl-3-0).

## WhatsApp scope and accepted constraints

The operator would own the business application and number. Users message that
number and link their WhatsApp identity to their own GSV installation.

As checked on 2026-09-10, Meta's Business Solution Terms, last modified
2026-03-06, restrict general-purpose AI assistants, with an exception for users
whose registered numbers have European Economic Area or Brazilian country codes.
GSV appears to fall within the general-purpose assistant definition. Acceptance
of this product constraint does not imply worldwide availability.

The Business Messaging Policy requires approved message templates outside the
24-hour window after a user's last message. Proactive Ship follow-ups need an
explicit adapter delivery design for that condition. Account eligibility,
applicable pricing, country coverage, and current policy must be rechecked when
the adapter is implemented; acceptance of restrictions is not provider approval.

Sources: [Business Solution Terms](https://www.whatsapp.com/legal/business-solution-terms?lang=en)
and [Business Messaging Policy](https://whatsappbusiness.com/policy/).

## Hosting implementation

1. Extract the reusable installation directory, bootstrap/onboarding, and
   operator administration from the private Accounts service into public GSV.
   H&M consumes that implementation instead of maintaining a second Accounts
   core. Keep operator-specific commercial policy and credentials separate.
2. Provide one deployment/bootstrap flow: common runtime and directory,
   configured domains and operator access, first installation, one-time setup
   link, and explicit administration for additional installations. Default to
   closed registration. Derive installation identity from trusted routing;
   arbitrary wildcard hostnames never allocate an installation.
3. Use the existing managed Telegram and Slack implementations as the basis for
   common adapter behavior. Discord needs corresponding work. Implement
   WhatsApp Business separately under the scope above.
4. Replace hosting-mode checks with adapter/service availability and the signed-in
   account's permissions. Keep user-supplied model credentials supported. Mail,
   operator-funded inference, and telemetry are independently optional services.
5. Remove the obsolete standalone composition, adapter entrypoints, singleton
   addressing, mode branches, and documentation end to end at the announced
   cutover. Protect the existing managed installation and resource identities.
6. Validate a clean deployment using public components only, with two independent
   installations, identical local usernames and paths, normal onboarding and
   identity linking, and isolated restart/reset/deletion behavior. Validate H&M's
   composition against the same public contracts.

The first hosting milestone is a fresh public deployment with two installations,
normal onboarding, Telegram linking, and user-supplied model credentials.

## Thin H&M infrastructure

The inspected `../infrastructure/src/gsv/managed.ts` has 777 lines combining
reusable provisioning and H&M policy. The target is a short stack entrypoint and
tens of lines of stage configuration, with shared provisioning owned by GSV.
This is a design target, not a measured final reduction.

Public deployment inputs should cover a deployment name, stage, domain, operator
access, enabled adapters, optional services, and secret references. Derive
ordinary resource names, routes, and callback URLs from those inputs. Keep
existing-name overrides for adopting an established deployment.

H&M keeps company domains and zone records, administrator configuration,
production/staging policy, secret bindings, existing resource-name overrides,
and any still-needed legacy route exclusions. Preserve Alchemy logical and
physical resource identities and retain policies while extracting the code.
Moving necessary provisioning into GSV reduces the private wrapper; removing
duplicate hosting mechanisms reduces total complexity.

Current ownership references: `deployment/src/runtime.ts`,
`deployment/src/standalone.ts`, `packages/gsv/src/services/`,
`workers/gateway/src/installation/`, and the operator's `services/accounts/` and
`services/deployment/`. The runtime security boundary remains installation
identity throughout the change.

## Web release work

The active UI development checkout is `gsv-history-renderer`. The isolated local
preview is port 5174 against gateway 8787; the separate `gsv-zen` preview on 5173
uses production and must not be mistaken for the isolated test environment.

The remaining work is measured against retained managed workflows, rather than
reproducing obsolete per-user provider-application setup. Existing completed UI
work and detailed behavior are recorded in `web/src/app/features/instrument/README.md`
and `web/src/app/features/instrument/settings/README.md`.

- [x] Finish adapter connection management for current managed Telegram and Slack:
  durable linked identity/status, reconnect and unlink. Implemented in the local
  preview on 2026-09-10 and verified with a disposable managed adapter fixture.
- [x] Complete contact conversations and cross-Ship request management in the
  appropriate Instrument surfaces.
- [x] Remove the temporary contact demo before release. Stopped and deleted the
  in-memory proxy and restored the LAN preview on port 5174 directly to gateway
  8787. Synthetic contacts, messages and requests were never gateway records.
- [x] Finish approval-policy recovery, account-grant inspection, and sign-out.
  The old UI has no richer conditional-policy or grant editor to migrate.
- [x] Support custom MCP headers in the add-server form. Verified with a real
  loopback MCP server in the disposable UI test environment on 2026-09-10.
- [ ] Verify the complete new-user and returning-user flows: onboarding/login,
  chat and media, approvals, models, connections, Memory, and live Fleet state.
- [ ] Make Instrument the default, then remove the old UI and presentation code
  once the workflow inventory is complete. Existing deep links need no mapping.
- [ ] Validate and release the web change before starting the hosting cutover.

These are release requirements, not claims that the work is already complete.
Do not fold WhatsApp Business, iMessage, hosting migration, or a license change
into the remaining UI batches.


## Old UI retirement inventory

Audit of the actual route and component implementations on 2026-09-10. The old
shell remains reachable while the retained controls are reviewed. The maintainer
approved the scope below; final smoke testing and removal remain separate work
after this review. Existing deep-link compatibility is explicitly out of scope.

| Workflow | Instrument status | Work before retiring the old surface |
| --- | --- | --- |
| Personal chat, process messages, attachments, tool inspection and approvals | Implemented in Zen and Fleet | Final integrated smoke |
| Models, fallback order, process choices and personal instructions | Implemented in Settings and Fleet | Final integrated smoke |
| Computers and browser connections | Implemented in Fleet | Final integrated smoke |
| Managed Telegram/Slack links, reconnect and unlink | Implemented in Settings | Completed browser validation |
| Contact invitations, identities, messages/media and requests | Implemented in Fleet | Completed two-Ship browser validation |
| Simple approval rules, stored-policy inspection/replacement and sign-out | Implemented in Settings | Completed browser validation |
| Memory reading, search, links and correcting existing pages | Implemented in Memory | Final integrated smoke using Instrument routes |
| New Memory pages | Quiet new-page action uses the existing editor, checks name collisions and preserves concurrent edits | Review with the reader; collection setup/capture/build stay with Ship or commands |
| File reading, editing, download and deletion | Preview expands to a wide reader/editor; return restores selection and scroll | Review; general file creation remains in Zen commands/Ship |
| Responsibilities, standing-source switches and scheduled routines | Fleet has current/history, details/blockers/next checks, process filters, cancellation, standing switches and routine create/edit/pause | Review controls and live updates |
| Repository import, refs, history and comparison | Maintainer approved keeping dedicated repository UI out | Native `rgit` commands are available through `gsv shell`/Zen; removal remains a syscall/CodeMode operation |
| Image, transcription, speech, shell and server configuration | Maintainer explicitly rejected these extra controls; use good defaults | Timezone is the only added preference; existing model stack and effort controls remain |
| Agent account creation and account-specific defaults | Processes have creation and preference controls; `proc accounts` lists runnable accounts | Explicit CLI gap: account creation is currently a syscall/SDK/CodeMode operation, not a native account-management command; settle before deleting the old route |
| Standalone terminal workspace and detailed runtime traces | Fleet command opens Zen on the chosen target; ledger inspection adds bounded failure reasons, duration and request details; full tool output stays in Zen | Maintainer agreed to one terminal and useful inspection, without a separate trace chart |

Source inventory: `web/src/app/features/gsv-shell/routing/shellRoutes.ts`,
`web/src/app/features/gsv-console/components/GsvConsole.tsx`, and their referenced
workspaces. The old `AgentToolsPanel` accepts a capabilities prop but does not edit
grants. Runtime approval compatibility reads legacy `when.target`; it does not
implement arbitrary conditions. The new UI must not imply otherwise.

Removal must keep genuinely shared domain and service code used by Instrument,
move it out of the obsolete presentation namespace where appropriate, and remove
obsolete pages after retained workflows are tested through Instrument. Design
catalog routes are a separate development surface.


## Review batch: responsibilities, routines, Memory and files

Implemented for the isolated 5174 preview on 2026-09-10. This batch does not change
the default route, delete the old UI, merge, or deploy production.

- Work stays in Fleet tables and the existing inspector, after Contacts. History
  and standing policies are loaded when opened; owner-scoped change notices update
  affected open lists without polling. Scheduled tasks outside the recurring Ship
  routine editor remain inspectable and can be paused.
- A routine edit retains existing target metadata, priority and interval anchor.
  It checks the latest editable definition before saving. Scheduler updates do
  not yet offer an atomic revision precondition; that race remains at the syscall
  boundary rather than being hidden by the UI.
- Memory page writes use the repository head as a precondition for the page and
  index change. New pages refuse collisions; editing refuses a changed baseline.
- Wide file reads/downloads use versioned file references. Text editing is limited
  to 1 MiB; image display to 8 MiB; downloads currently use the shared 25 MiB
  resource reader. Saves reread the target and retain a draft on an observed
  conflict. `fs.write` does not provide an atomic compare-and-swap precondition.
- The user timezone belongs to the human, influences Ship and defaults for new
  routines, and leaves existing routine timezones intact. No media, shell or
  installation-name settings were added.
- Failure messages are bounded ledger data with the same owner authorization and
  archive retention as other ledger fields. Existing archived rows remain readable.

Maintainer-authored comments about Fleet's former command line and the old
AI/UI-only config prefix list were preserved; the implementation now routes the
command to Zen and additionally allows locale preferences.
