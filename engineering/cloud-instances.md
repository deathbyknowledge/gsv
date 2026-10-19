# Cloud instances and saved browser profiles

Status: browser slice implemented and live viewing validated locally and with
Cloudflare Browser Run; Linux template remains planned. Provider documentation
checked on 7 October 2026.

The current browser slice includes shared extension commands, explicit instance
lifecycle, encrypted saved profiles, human control inside Instrument, usage
reservations, and installation deletion ownership. See the
[cloud browser guide](../docs/how-to/cloud-browsers.md) for its actual interface.
The sections below retain the broader design, including work not shipped yet.

Local Wrangler implements Browser Run's fetch/CDP transport, but did not implement
the native `acquire()` binding method during the feasibility test. The provider
uses `@cloudflare/playwright` acquisition and the documented session endpoints.
Instrument owns the viewer so human input uses GSV's existing authorization,
input ordering and handoff lifetime. Cloudflare's hosted Live View remains an
alternative, but its documented URL expiry governs new connections and is not
a documented per-viewer revocation mechanism. We have not established its
compatibility with a GSV proxy endpoint. The GSV viewer uses CDP screencast,
authenticated syscall bodies and the existing WebSocket binary transport.
Capture is shared per page, while small binary windows and replacement of unsent images bound
each viewer's image backlog. Closing a view cancels its body and subscription without
stopping the browser. This reuses GSV's ownership, responsibilities and navigation
instead of introducing a second handoff runtime.

On 7 October, a synthetic page updating every 50 ms displayed about 20 fps in
Instrument. Local median/p95 image age was 35/52 ms; with a remote Cloudflare
browser and local gateway it was 118/183 ms. These measure a timestamp painted
into the image, through image display, rather than only CDP delivery. Site load,
network path and content change the result. Screencast output remained 1280×800
regardless of device pixel ratio; JPEG quality is 90. Larger advertised capture
bounds do not establish higher effective resolution.

Ship should be able to start a cloud browser or Linux machine, use it as an
ordinary GSV target, and stop it when the work is finished. A saved browser
profile keeps login state between browser instances. When a person needs to
sign in, GSV presents that request in Chat and opens the browser from Fleet or
the conversation.

The governing invariant is explicit lifetime: **one start creates one instance;
a terminal instance never starts again.** A new start gets a new instance and
target identity. Saved profiles and files have their own lifetimes. Ship chooses
when resources are needed; the runtime enforces authorization, quotas, expiry,
and cleanup.

This proposal defines the contracts before implementation. It excludes importing
sessions from extensions, an always-running default browser, and automatic
recreation behind an existing target ID. The first Linux release uses disposable
workspaces with explicit file export.

## Ownership and integration

GSV already separates [targets](../docs/architecture/targets.md),
[protocol peers](../docs/architecture/unified-protocol-peers.md), and
[provider services](../docs/architecture/services.md). Cloud resources fit those
boundaries:

| Component | Responsibility |
| --- | --- |
| Ship and delegated Processes | Decide to start, use, and stop instances; retain unfinished work in the existing responsibility ledger. |
| Kernel | Derive installation and human owner, authorize management and target calls, maintain target access and routing, publish lifecycle events. |
| Optional instance service | Own provisioning, instance records, deadlines, profile storage, human handoffs, and authoritative usage accounting. |
| Browser provider | Implement the browser target using shared browser commands and Cloudflare CDP; own browser connections and command cancellation. |
| Container driver | Run ordinary foreground `gsvd`; implement existing filesystem, shell, cancellation, and network contracts. |
| Instrument | Present instances, saved profiles, human requests, and usage through existing web and Desktop surfaces. |

Add an optional installation-scoped service contract under
`packages/gsv/src/services/`, following the existing `getInstallation()` pattern.
Only the trusted Gateway binding supplies `installationId`. Kernel supplies the
authenticated owner and acting Process context; public start arguments cannot
select an installation, owner, provider credential, or arbitrary container image.
The service validates the admitted template and entitlement policy itself.

The service owns resource state. Kernel retains the minimum projection needed
for access, expected enrollment, routing, and terminal identity fences. Provider
callbacks carry an owned operation identity and increasing revision. Kernel
rejects stale revisions and callbacks for another installation or an instance
already made terminal. Binding authority permits only the corresponding
lifecycle operations; it does not grant arbitrary Kernel calls.

An installation coordinator owns instance admission, profile leases, and local
allowance reservations in one transactional store. Instance execution can have
separate durable owners keyed by installation and instance. Reserving shared
provider capacity is a separate, recoverable operation with the same request
identity; it must not rely on a transaction spanning Durable Objects.

Browser execution should use a service peer carrying ordinary request, response,
body, and cancellation frames over a service binding. This needs a service target
route alongside the current machine and adapter routes in
[target routing](../workers/gateway/src/kernel/targets.ts); a browser provider is
not a messaging adapter. `gsvd` uses its existing WebSocket transport. Both paths
enter the same syscall authorization and target dispatch boundary.

## Instance lifecycle contract

The proposed namespace is `sys.instance.*`, exposed through an `instance`
command on the native `gsv` target and through CodeMode. It adds no model tool.

| Call | Input and result |
| --- | --- |
| `sys.instance.catalog` | Return entitled templates, supported capabilities, lifetime bounds, and usage units. Initially offer one browser and one Linux template. |
| `sys.instance.start` | Accept a persisted `requestId`, `templateId`, optional label, requested lifetime, and optional browser `profileId`; return the durable instance record. |
| `sys.instance.list` | Return visible instance records, including starting instances and retained terminal records. |
| `sys.instance.get` | Resolve an instance by `instanceId` or its `startRequestId`, including when the original start response was lost. |
| `sys.instance.stop` | Stop by either identity above; return the current record. Repeated calls have the same effect. |

The minimal public record is:

```ts
type Instance = {
  instanceId: string;
  targetId: string;
  startRequestId: string;
  templateId: string;
  templateRevision: string;
  kind: "browser" | "linux";
  label: string;
  state: "starting" | "ready" | "stopping" | "stopped" | "failed";
  revision: number;
  profileId?: string;
  createdAt: number;
  readyAt?: number;
  expiresAt: number;
  stoppedAt?: number;
  reason?: string;
  diagnosticRef?: string;
};
```

Times are epoch milliseconds. `expiresAt` is fixed at admission and covers the
whole allocation, including startup. The catalog defines lifetime defaults and
bounds; the admitted record makes the accepted deadline explicit. The first
version has no lease-extension API. A longer job must request enough time or
checkpoint its outputs before expiry.

### Start and readiness

Kernel applies capability and existing Process approval policy to the actual
start, including the template and profile. It persists the start identity before
provider dispatch. The service atomically claims the profile, reserves allowance
and a concurrency slot, records fresh instance and target IDs, then provisions.
The request returns after durable admission; waiting for readiness does not hold
the Process tool open for the resource's lifetime.

Repeating the same request with identical arguments returns the same operation,
even after it has stopped. Reusing the identity with different arguments fails.
An uncertain provider allocation is reconciled before another allocation is
attempted. A lost response never authorizes another paid resource. Retain start
receipts or tombstones so pruning detailed history cannot make an old request
allocate again.

The provider trial must establish how to recover an allocation whose response
was lost. If create has no idempotency or recoverable identity, keep that attempt
uncertain until its possible resource is found or proven expired; never retry
create blindly. Provisioning policy must bound and account for orphan cleanup.

`ready` means the provider has restored requested state and established an
authenticated route with the advertised implementations. A running Chromium
process or container alone is insufficient. Starting and terminal instances are
visible in the instance inventory, while ordinary target calls require a live,
ready route. Connection availability remains distinct from instance lifetime.

Reconnect may attach to the same surviving browser session or daemon. If that
underlying session or daemon has died, the instance terminates. Starting a fresh
browser, container, or daemon requires a new explicit instance. Kernel's existing
offline-target response must never allocate resources as a side effect.

### Stop, cancellation, and failure

The normal transitions are `starting -> ready -> stopping -> stopped`. Startup
or provider loss can lead to `failed`, after resource cleanup is confirmed.
While termination is uncertain, retain `stopping`, the reservation, and a
diagnostic reference; do not claim that a possibly running resource is gone.

Stop first fences new work, cancels owned operations and any human handoff,
attempts a bounded profile save, and terminates the provider resource. It revokes
the target route and enrollment authority. Stop during startup prevents a late
ready callback from reviving the target and cleans up any late allocation.
Stopping by start identity can record cancellation before allocation completes.

Cancelling the caller's start request does not prove an admitted resource was
stopped. The owning operation reconciles by the persisted request identity and
issues explicit stop when cancellation requires teardown. Once ready, an
instance survives an individual tool cancellation; explicit stop, expiry, or
provider loss ends it. Ship records any intended cleanup in its responsibility
ledger, and provider deadlines remain the backstop if that Process disappears.

Idle cleanup is a documented template policy. Active shell work and bounded
human interaction prevent ordinary idle cleanup; transport pings do not count as
useful work. Absolute expiry still applies. Cloudflare browser idle timeouts and
deployment interruptions remain provider constraints, so keepalive management
must operate within the admitted lifetime. [Browser limits](https://developers.cloudflare.com/browser-run/limits/)

Forgetting a managed target must not orphan a running instance. The existing
target deletion path must perform stop before forgetting it. Restricted spaces,
expired entitlements, and exhausted allowances still permit authorized stop and
service-owned cleanup, without admitting new execution.

### What recovery means

Suppose Ship clicks a site's Submit button and the browser disconnects before
the result arrives. The site may already have accepted it. GSV records the
outcome as unknown; recovery inspects the site's result before deciding whether
another click is needed. The runtime must not replay the click in a fresh
browser. Public reading can usually resume by opening the URL again.

For Linux, preserve the existing durable shell contract: persist the target and
fresh `sessionId` before `shell.exec` with `start: true`; recovery polls or cancels
that session. It never repeats an uncertain start or stdin write. Daemon death
ends the session even if its files can later be restored.

## Browser commands and persistent profiles

The browser target continues to expose `shell.exec` and real filesystem
operations. Extract the environment-independent command and page semantics from
[the extension driver](../extension/src/background/driver.ts) into a shared
package, with separate extension and Cloudflare backends for CDP, tabs, storage,
and file handling. Do not introduce a separate Playwright tool vocabulary for
Ship.

The first compatibility boundary covers tab creation and selection, navigation,
semantic page snapshots, element references, interaction, screenshots, and file
transfer. The same command must have the same output and cancellation semantics
on both targets. Element references are tied to their instance, tab, and document
generation; references from a dead instance cannot address a replacement.

Help and `/proc/browser.json` describe the backend and supported commands.
Personal desktop history, bookmarks, clipboard, installed extensions, downloads,
and extension-local storage must not be presented as if they came from the
user's laptop. Implement coherent cloud equivalents where useful and advertise
only supported behavior. In particular, the extension's `storage local` command
accesses extension storage; it is not the profile authentication store.

Websites can distinguish a cloud browser from the user's personal browser.
Cloudflare also identifies Browser Run traffic as automated. Command compatibility
therefore cannot promise identical site access or login behavior. [Browser FAQ](https://developers.cloudflare.com/browser-run/faq/)

### Profile API and lifetime

The proposed `sys.browser.profile.create/list/get/delete` calls manage profile
metadata. Creation takes an idempotent request identity and label. A profile
record exposes `profileId`, label, revision, last successful save time, save
status, and its active instance, if any. It never returns the stored auth blob.
The native command is `browser profile ...` on `gsv`.

Starting with a profile restores its latest committed state; starting without
one gives a temporary browser. The first version allows one live instance per
profile, including startup and shutdown. Concurrent work can use multiple tabs
in that instance or distinct profiles. A competing start returns `profile_busy`
with the existing instance reference when the caller can see it.

Profile authority is scoped to the immutable installation and human owner.
Kernel checks both the calling Process's capabilities and authority to use that
owner's profile. Target access does not automatically authorize every saved
profile. Cross-owner profile sharing is outside the first release.

Cloudflare Playwright supports exporting and restoring cookies, localStorage,
and IndexedDB. Use this as the initial persistence format. It does not promise a
complete Chrome profile, live tabs, JavaScript memory, or every site's login
mechanism. Sites can expire sessions or demand another sign-in. [Authentication persistence](https://developers.cloudflare.com/browser-run/playwright/)

### Saving and forgetting logins

One durable owner serializes each profile's lease and revision. Store immutable,
encrypted state blobs under installation- and owner-scoped storage addresses;
atomically advance the profile's current revision after a successful write.
Bind encryption to the installation, owner, profile, and revision. Keep
persistence blobs and encryption keys out of target filesystems, tool results,
conversation history, logs, and telemetry.

Save after human login, at suitable command boundaries and bounded intervals,
and during orderly stop. A failed save retains the previous usable revision and
surfaces its age. Stop cannot wait indefinitely for persistence. A crash can lose
changes since the last save, including refreshed login state; Fleet must not
claim newer state was saved. Old instance callbacks cannot overwrite a newer
revision or a deleted profile.

Deleting a profile first fences new leases and saves, stops its active instance,
then erases its stored revisions and owned keys. Ordinary profile deletion and
installation deletion both report remaining provider or backup retention
through the owning lifecycle contract. Forgetting local state is distinct from
revoking a session on the website itself.

The user-facing setup should explain the useful behavior plainly: sign in to
this cloud browser once so Ship can use it while personal devices are offline;
some sites will occasionally require another sign-in. Encryption protects
stored copies, while the service running the authenticated browser remains a
trusted part of the deployment.

## Human browser interaction contract

The first login path is direct entry in the live browser. A messenger request
opens an authenticated GSV action for the specific site and browser; the person
completes login there and returns control. Ordinary chat keeps its normal
routing. A future field-input feature would need an explicitly selected request
and destination, rather than intercepting the next message. It would also need
to account for the messenger's own retention of anything typed into chat.

Browser interaction is a durable request attached to an instance and the work
that needs it. It shares GSV's human-facing surfaces, but does not reuse
`proc.hil`'s approve/deny payload: signing in is a different action from granting
permission to execute a syscall.

| Proposed call | Contract |
| --- | --- |
| `sys.browser.handoff.request` | Accept `requestId`, `instanceId`, tab identity, purpose, and an existing responsibility reference for agent work. Return durable metadata and an authenticated GSV action path. |
| `sys.browser.handoff.get` | Return state, instance/tab identity, deadline, and completion outcome; never a provider access URL. |
| `sys.browser.handoff.open` | For the authorized human only, recheck the live request and mint access to its exact browser view. |
| `sys.browser.handoff.cancel` | End the interaction and revoke its control access; repeating cancellation is harmless. |

The service derives the profile and generation from the instance. It permits one
active handoff per instance in the first release. A person can also take control
from Fleet without creating agent work. Agent requests associate with an
existing responsibility; Kernel validates that association and records the
request reference in the responsibility's details. The provider owns interaction
state, while `r12y` continues to own the commitment to resume work.

The interaction states are `pending`, `active`, `completed`, `cancelled`,
`expired`, and `failed`. Completion reports that the human finished the
interaction; it does not certify that the website accepted a login or approved a
transaction. Ship verifies the resulting page using ordinary browser commands.

### Handoff sequence

1. Persist the request and reserve human control. Stop admitting browser
   automation for that instance and settle or cancel in-flight commands before
   giving the person access.
2. Subscribe to the provider completion event before starting its handoff. Set a
   deadline bounded by both the instance lifetime and the provider limit. Persist
   the provider handoff identity for reconciliation.
3. Surface a Chat action such as **Sign in to continue**, with the site, browser,
   task purpose, and time remaining. Its action path contains only GSV identity;
   the signed-in human obtains provider access when opening it.
4. While the person controls the browser, reject agent page reads and mutations
   with a structured `human_control` result. Suspend GSV page capture, tracing,
   and network recording that could retain credential entry. Metadata, status,
   cancellation, and stop remain available.
5. On completion, end human input access before releasing the browser for
   automation. Save profile state and its outcome, record completion durably,
   and emit the correlated GSV event. Wake the associated responsibility once.

Cloudflare supplies `Cloudflare.handoff`, `Cloudflare.handoffComplete`, and
`Cloudflare.getHandoffState`; the structured flow uses Live View's `tab` mode.
Explicit handoffs are limited to thirty minutes; omitting the timeout leaves
them unbounded. GSV must always supply a bounded timeout. [Human handoff](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/)

Recovery reconciles a known handoff instead of issuing another one. If a provider
completion event was lost and the outcome cannot be recovered, report that
uncertainty and inspect the current page after regaining control. Do not invent
a successful login. Completion delivery is idempotent and checked against the
current instance, request revision, and responsibility state.

Only the associated work waits. Ship can receive messages and work elsewhere;
this is not a long-running tool awaiting a browser promise. Ordinary Process
replacement does not erase a surviving responsibility. Cancelling the task or
stopping the instance cancels its handoff, and a late event cannot reactivate
cancelled work or an obsolete Process run. Set the responsibility's next check
from the handoff deadline, rather than relying on the generic waiting default.

### Live View in Instrument

Chat owns the request and completion messages. Fleet owns the running browser,
tabs, saved profile, expiry, and Open/Stop actions. A normal watch action should
issue read-only viewing access; taking control enters the handoff contract.
Settings owns profile preferences and forgetting saved logins. These are views
of the same instance and request records, not separate workflow stores.

Cloudflare's hosted Live View can open from a generated URL and supports a
read-only viewer restriction. Embed it inside Instrument only after verifying
framing, authentication, and Desktop behavior. Opening its hosted tab is a
viable first presentation; the request and task remain in GSV. [Live View](https://developers.cloudflare.com/browser-run/features/live-view/)

A Live View URL carries bearer access. Its expiry limits new connections;
existing connections can remain until the browser session ends. Keep these URLs
out of agent results, Messages, ledger rows, referrers, and telemetry. Return
them only through the authenticated human opening flow. Messenger actions link
to that GSV flow, not directly to the provider URL. [Live View access](https://developers.cloudflare.com/browser-run/features/live-view/)

The implementation must prove that completion and cancellation end input access
and prevent reuse of previously issued control links. URL expiry alone is
insufficient. If the hosted control path cannot enforce this, use a GSV-controlled
viewer connection before shipping handoff; do not silently replace the running
instance to simulate revocation. This is a provider integration gate, independent
of whether the view can be embedded.

## Linux instances

The first Linux template runs a pinned `linux/amd64` image with foreground
`gsvd` as an unprivileged user. It gives Ship real processes, package tools,
Python and Node runtimes, builds, tests, and file conversion while the user's
computer is offline. The existing just-bash target remains useful for lightweight
GSV-local composition.

Kernel prepares enrollment only for the admitted instance and exact target.
Bootstrap authority is single-use and short-lived; the resulting driver
credential cannot enroll another target or call human syscalls. Neither belongs
in the image, exported workspace, or snapshot. This is an internal provisioning
path under the existing enrollment authority, without a human pairing dialog
for every container start. Shell commands must not inherit bootstrap secrets in
their environment or find them in workspace files.

Reuse `gsvd` filesystem, shell-session, body-stream, and process-tree cancellation
behavior. The instance service owns container lifetime and coordinates idle
policy with outstanding work. Shell sessions and network keepalives must not
accidentally depend on a container's unrelated Durable Object inactivity timer.
Cloudflare Containers provide isolated Linux execution; their native lifecycle
API is the initial integration point. A second Sandbox command/session runtime
is unnecessary for this design. [Container architecture](https://developers.cloudflare.com/containers/concepts/architecture/)

Initial persistence is explicit `fs.copy` of inputs and outputs to an existing
durable GSV target. Live process state dies with the instance. Filesystem
snapshots can be added later as a separately named workspace feature.
Cloudflare's current snapshots require the `durable_object` scheduling policy,
are tied to an image version, omit process memory, and expire after thirty days
unless restored. They cannot by themselves be GSV's permanent workspace store. [Container snapshots](https://developers.cloudflare.com/containers/guides/snapshots/)

## Entitlements and usage

Use the existing entitlement snapshot for policy, with new named values. The
following are proposed keys, not existing allowances or product prices:

| Keys | Meaning |
| --- | --- |
| `browser.enabled`, `compute.enabled` | Admit the corresponding resource kind. |
| `browser.concurrent_instances`, `compute.concurrent_instances` | Maximum admitted instances, including startup and unconfirmed shutdown. |
| `browser.period_seconds`, `compute.period_unit_seconds` | Usage allowance per service-owned billing period. |
| `browser.max_instance_seconds`, `compute.max_instance_seconds` | Maximum admitted lifetime. |
| `browser.saved_profiles`, `browser.profile_storage_bytes` | Count and total retained storage bounds, including retained revisions. |
| `compute.capacity_units`, `compute.template.<id>` | Concurrent compute capacity and permitted templates. |

The instance service uses atomic reservations and durable settlement. A cached
entitlement map does not act as a live usage counter. Missing or expired policy
cannot admit paid resources. Deployment-wide provider concurrency and creation
rate limits apply in addition to each installation's allowance; admissions must
respect both before allocating.

For the first release, reserve the full requested lifetime at start. Browser
allowance uses seconds; compute uses seconds multiplied by the template's fixed
capacity weight. Return the accepted deadline and reserved amount. Insufficient
allowance produces a clear error with the available duration instead of silently
shortening a job. Starting multiple instances cannot spend the same allowance.

Customer usage starts at readiness and ends at confirmed termination, capped by
the admitted lifetime. Waiting for a human counts while the instance runs.
Settlement releases unused reservations and happens once per instance;
failed startup releases the customer allowance after cleanup. Provider overruns
beyond the promised expiry remain separately visible operator costs. Usage
records retain template revision, rate weight, timestamps, and outcome, without
page contents or command arguments.

This simple allowance is separate from the provider cost ledger. Browser Run
charges include duration and concurrency; Containers charge for dimensions
including allocated memory and disk and consumed CPU. Preserve those dimensions
for reconciliation, along with relevant storage and network costs, even if the
user sees one balance. Product pricing and period boundaries remain operator
policy. [Browser pricing](https://developers.cloudflare.com/browser-run/pricing/), [Container pricing](https://developers.cloudflare.com/containers/platform/pricing/)

## Implementation sequence and acceptance

| Batch | Concrete result and required validation |
| --- | --- |
| Provider feasibility | Run a browser login/save/close/restore trial, verify allocation recovery and control revocation, measure startup, and verify hosted viewing plus current container APIs and pinned SDK compatibility. Test actual supported sign-in flows rather than assuming a saved cookie is sufficient. |
| Lifecycle foundation | Public instance service and syscall contracts, optional deployment binding, Kernel authorization and service target routing, durable admissions, expiry, stop, and accounting. Test simultaneous starts, lost responses, stop during startup, provider loss, and stale callbacks. |
| Browser target | Shared extension/cloud command core and one browser template. Run the same command, reference, streaming, and cancellation fixtures against both backends; retain extension behavior. |
| Profiles and handoff | Serialized encrypted profile storage, durable interaction requests, responsibility wakeups, and Chat/Fleet presentation. Exercise login, expiry, cancellation, failed saves, control revocation, Process replacement, and duplicate completion. |
| Linux template | Foreground `gsvd`, scoped bootstrap, readiness, deadline enforcement, output export, and usage. Test filesystem transfer and durable shell recovery across a connection loss; daemon loss must terminate the instance. |
| Release integration | Clean-installation flow with no connected personal devices; active/restricted transitions, quota exhaustion, owner isolation, reset and deletion. Update public docs, the target/protocol architecture contract, and the GSV Manual alongside the implementation that changes each workflow. |

Before changing Instrument, describe each new view's user task and actions in the
existing [application design process](./builtin-app-design.md). The first useful
implementation slice is a disposable browser with reliable stop and accounting.
The user-facing browser release should include remembered logins and human
interaction. Linux can consume the same lifecycle contract once the browser
proves it.

The instance service must join Accounts' deletion-owner inventory. Quiescence
fences new allocation, callbacks, profile writes, and human access; erase covers
profiles, credentials, instance records, and retained provider artifacts. Reset
does not carry these resources into a replacement installation ID. Track retained
copies using the existing
[installation lifecycle contract](../packages/gsv/src/services/lifecycle.ts).

The browser implementation changes runtime behavior only when the optional
instance binding is present. Production prompts remain unchanged. Real remote
website acceptance, provider billing reconciliation, and the Linux template need
their own validation before release.
