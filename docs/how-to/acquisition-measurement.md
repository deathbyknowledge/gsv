# Ship web acquisition measurement

This optional browser integration is separate from the provider-neutral runtime
telemetry seam. It is disabled unless the web/signup build sets
`VITE_ACQUISITION_ENABLED=true`; other operators' domains and native clients are
not enabled. Marketing independently gates cookieless milestone reporting with
`analyticsEnabled`; its advertising `enabled` and `reviewed` gates remain false.
There are no new authentication steps or protocol methods.

The marketing repository `ka-wah/gsv-space` owns the Pixel ID, public consent
configuration, non-blocking consent preferences, fixed-origin measurement bridge,
Meta SDK, conversion deduplication, and the existing managed cookieless analytics.
Its `docs/acquisition.md` is the deployment, privacy-review and Meta Events Manager
Test Events runbook. Pixel ID 1168711929173445 is configured there, not in the runtime.
Advertising remains off until both repositories' enablement gates are reviewed.

For organic X/LinkedIn posts, use the marketing repository's
`docs/organic-social-tracking.md`. The reviewed client build flag can enable
first-party milestone delivery while advertising stays off. Organic reporting
reuses the existing cookieless analytics and privacy controls, without advertising
cookies, a consent banner, the Meta SDK or a persistent conversion ledger. Explicit
campaign labels are carried through signup and attached to successful milestones.
An untagged return visit or reload after onboarding clears its URL can lose those
labels; this does not guarantee source-attributed retention across days or devices.

`web/src/app/services/acquisition.ts` loads only the first-party coordinator. It
snapshots allowlisted UTM tags before onboarding clears its URL, and sends only a
milestone name, an opaque deterministic event ID and occurrence time. Messages,
email addresses, attachments, onboarding tokens, account IDs and private URLs never
go into that payload. Browser/advertising identifiers and normal network data are
nevertheless inherent to Meta's SDK and require the separate advertising consent.

The two successful outcome boundaries are:

- `sessionService.setup`: a successful `sys.setup` response for managed signup,
  before local credential cleanup/login. This emits CompleteRegistration; code
  verification, a handle reservation, failed setup, sign-in and standalone/operator
  setup do not. Existing service-term consent does not grant advertising consent.
- `useChatOutbox`: an acknowledged primary Ship chat send. Before emitting the custom
  FirstTaskSubmitted milestone, the authenticated canonical history must show no
  earlier user message, including messages from another browser/messenger. Background
  work, subagent chats, drafts, uploads and failed sends are excluded. This measures
  submission, not AI task completion, and never classifies or exports message text.

## Build and release organic reporting

The marketing landing page, the owner signup page and the personal Ship app are
separate release surfaces. Deploying the marketing Worker does not add these
hooks to the signup/app bundles. Merge the app changes, then set the following
in the existing managed release's **build environment**:

```sh
VITE_ACQUISITION_ENABLED=true npm run build --workspace web
```

The web build includes the normal app and `build:signup` output under
`web/dist/owner-signup`. If the operator release rebuilds web assets, pass the
same flag into that build too. Adding it only as a Worker runtime variable does
not change an already-built Vite bundle.

Release those assets through the managed operator's existing Gateway and Accounts
composition, preserving its Worker names, routes and state. The public repository's
new-operator Alchemy defaults are not a substitute for the existing hosted Ship
release configuration. No new operator stack, database or migration is required.
The marketing bridge must already be deployed with `analyticsEnabled: true` and
advertising gates `enabled: false`, `reviewed: false`.

After the reviewed release, open a campaign QA link, complete a fresh signup and
submit one task. Check the campaign dashboard's Test events section for the
account and first-submission milestones. Existing-account login and a second
message must not emit a new registration or first-task milestone. Keep normal
analytics opt-out and browser privacy controls enabled as configured.

To stop this optional client integration, rebuild with
`VITE_ACQUISITION_ENABLED=false` and release those assets through the same owner.
This does not change the independent website analytics or enable advertising.

Both measurements run asynchronously and fail without changing the successful
product action. The existing signup destination is retained exactly; five safe UTM
parameters are appended without touching the onboarding/contact fragment. No
account, credential, setup, Kernel schema or backend infrastructure was changed.

For reviewed advertising, the common-origin bridge atomically deduplicates browser
emission across tabs and subdomains and supplies stable Meta event IDs. Browser Pixel delivery is not an
exactly-once transactional service: blocked storage/network, tab closure, a crash
or cleared storage can lose events. There is no server-side outbox or CAPI fallback.
Attribution in managed analytics uses explicit campaign properties, preserving its existing
cookieless policy instead of claiming reliable person-level identity stitching.

Validate with web typecheck, tests and both normal web/signup builds. Focused checks:

```sh
npm run check --workspace web
npm run test:run --workspace web -- src/app/services/acquisition.test.ts src/app/services/session/sessionService.test.ts src/app/services/chat/hooks/useChatOutbox.test.tsx src/signup/page.test.tsx
npm run build --workspace web
```

Before advertising activation, follow the marketing runbook to review the privacy notice,
consent copy, retention, dataset automatic-event/advanced-matching settings, domain
permissions, production build variables, and actual Test Events payloads. No live
Meta Events Manager verification has been performed by these automated checks.
