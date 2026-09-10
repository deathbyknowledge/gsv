# Unified hosting and web release

Recorded 2026-09-10 from the maintainer's hosting and web UI discussion.

This is the agreed direction and release plan. It describes future work; the
current runtime still supports managed and standalone deployments. Update the
engineering contract and architecture references when the cutover is implemented.

## Decisions

- Finish and release the new Instrument web UI first, against the current managed
  runtime. Retire the old desktop UI once retained workflows have replacements.
  Keep UI batches small and check in with the maintainer before expanding them.
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

- [ ] Finish adapter connection management: durable linked identity/status,
  reconnect and unlink, starting with Telegram; check existing managed Slack.
- [ ] Complete contact conversations and cross-Ship request management in the
  appropriate Instrument surfaces.
- [ ] Finish retained permissions/account-grant controls and MCP custom headers.
- [ ] Verify the complete new-user and returning-user flows: onboarding/login,
  chat and media, approvals, models, connections, Memory, and live Fleet state.
- [ ] Make Instrument the default and migrate supported deep links, then remove
  the old UI and presentation code once the workflow inventory is complete.
- [ ] Validate and release the web change before starting the hosting cutover.

These are release requirements, not claims that the work is already complete.
Do not fold WhatsApp Business, iMessage, hosting migration, or a license change
into the remaining UI batches.
