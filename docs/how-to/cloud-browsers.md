# Use a cloud browser

A cloud browser lets Ship use websites while your personal devices are offline.
It appears in Fleet alongside your connected browsers and computers. Your
operator must enable cloud browsers; the local development stack enables them.

For website tasks, Ship checks for a suitable existing browser and can start a
cloud browser when needed. You do not need to connect a personal browser or
explicitly ask Ship to create one. If browser access is unavailable, Ship should
explain the actual availability or startup problem. A website may separately
require you to sign in through the browser view.

The browser list below Zen's prompt and in Fleet updates automatically as
browsers start, become ready or stop. Opening Fleet or refreshing is unnecessary.

By default, Ship can run commands, use the network and manage files in cloud
browsers without asking for each action. This includes websites whose logins
the browser remembers. To require approval, choose **Cloud browsers** in
**Settings → permissions** and set the relevant actions to **Ask** or **Block**.
Existing custom policies keep their rules. Connected personal browsers and
computers retain their separate approval requirements.

## Watch and use the browser

Ask Ship to use a browser. GSV reuses your account's current cloud browser,
including one that is still starting. More work can use another tab. Fleet's
**browser** action follows the same rule and opens the view immediately.

Click the browser below Zen's prompt, a browser link in its work receipt, or a
running browser in Fleet to watch Ship work. Zen stays open behind the view.
The browser window has tabs and an address bar, with the page filling its width.
Use **expand** for a larger view and **more → stop browser** to stop it;
**close** leaves the browser running. The text controls match the rest of Instrument.
The view follows the tab Ship is reading or interacting with, including text
reads and screenshots, and shows its cursor and clicks. Opening a background tab
leaves the view in place until Ship uses it. You can click, scroll, paste and type
directly in that view. Clicking pins the view to that tab; choose **Follow Ship**
to follow again. Watching leaves Ship running. Your input gets brief priority
while you are interacting, and browser actions run in sequence so a human click
cannot split an agent's click or typing action. Closing the view leaves the
browser and Ship running.
Switching tabs or returning to Follow Ship pauses input until an image from the
new view has loaded. Reconnection and returning from a hidden view also require
a fresh image before input resumes. Unsent input for the previous view is discarded.

The view streams page changes as they happen. It drops superseded images when
the connection is slow, and reconnects after an interruption. Hidden views pause
capture; opening the view again resumes watching the same browser. Images use higher JPEG quality for clearer text. Network and website latency
still affect how quickly an action appears.

Sign in directly on the website in this view, including any verification code.
Ship can also request your help with a particular website. Open the request in
Ship, or follow its link from your messenger and sign in to GSV. For these
explicit requests, automation pauses until you choose **I’m done — resume Ship**,
Ship cancels the request, or it expires. Closing the viewer leaves the request
available.
Choose **I’m done — resume Ship** after you finish signing in or completing the
requested steps. Once saving succeeds, the view confirms completion and stays
open, following Ship again.
Requests expire after fifteen minutes or when the browser stops, whichever comes
first. The link identifies one request; it never grants access without your GSV
login. An old link shows that its request has ended and cannot control or complete
a later request. Open the latest request from Ship when needed.
Your next chat message still goes to Ship. Website passwords and
verification codes belong in the browser view.

Passkeys and hardware security keys are unavailable in cloud browsers. GSV
reports this to websites before they can open an invisible native passkey
prompt that blocks page input. Choose the website's password or another
supported sign-in method. A site that requires a passkey needs your connected
personal browser.

The live tab strip shows up to 128 tabs within a bounded metadata budget. It
always keeps the tab Ship is using and the tab you selected. Very long tab
titles and addresses are shortened for display; the actual page URL is unchanged.

## Remembered logins and lifetime

GSV automatically keeps website cookies, local storage and IndexedDB for your
local account in this space. The next ordinary browser restores that saved
state; there is no profile picker. Saved state is encrypted and separate from
the running browser. Only one instance can use the same saved state at a time.
The account's automatic login store has a durable identity. Explicitly created
profiles remain separate, even if they are older or have a running browser.
Forgetting the automatic state makes the next ordinary start fresh; it never
switches to another saved profile.

Website storage tracking is limited to 128 distinct HTTP(S) origins, including
embedded frames. Already tracked origins keep their places; additional origins
do not expand the save workload or displace earlier sign-ins. Local storage and
IndexedDB from additional origins are not saved. Cookies are saved separately.

GSV saves periodically, after human input settles, when you finish a login
handoff, and before an ordinary stop. Closing a website tab does not forget its
saved data. Restore completes before the next browser becomes ready. If restore
fails, that start fails visibly rather than opening an empty replacement.

**I’m done — resume Ship** finishes a login handoff only after its save succeeds.
If saving fails, human control and the waiting Ship task stay open; retry
completion or cancel the request. Cancelling remains available while a save is
in progress.

A save waits for active browser commands and live-view input to settle. New
commands and input wait while the save completes, with their usual cancellation
and time limits. The live view stays open during saving.
Live-view input requests time out after ten seconds. A timed-out request is not
replayed; GSV retains the underlying operation until it settles, so saving and
space deletion cannot mistake a timeout for completed input.

**Stop browser** commits saved data before closing. If a website uses unsupported
storage or its storage cannot be read, GSV saves the other sites and reports
**saved with exceptions**. It retains that site's previous saved storage and
associated cookies, when available; cookies shared with its other subdomains
are retained too. Changes on the affected site may be lost on restart. A partial
save permits a normal stop and lists the affected sites for Ship and in the view.

If the whole save fails, for example because storage is full or an upload fails,
the browser stays running within its original lifetime, and the view offers
**retry save** and **stop without saving**. The warning shows the last save time.
Expiry and forced shutdown still close the browser; unsaved changes can be lost.
The previous successful snapshot survives a failed, oversized or timed-out save.
Export reads IndexedDB records sequentially and stops when the remaining storage
allowance is exceeded. An incomplete measurement reports a lower bound for the
required bytes; it does not read the rest of an oversized database. Serialization
and compression use bounded chunks, and restore checks the size while
decompressing. The encrypted snapshot format remains compatible with existing
saved logins.
Collection also bounds structural work to 65,536 visited values/property names and
128 levels of nesting per site. This limits temporary codec objects even when the
eventual JSON is small. A site exceeding that limit reports a partial save and
retains its earlier snapshot when available; healthy sites continue saving.
Within a space, cold profile restores and saves share one memory slot. Browser
maintenance runs sequentially, initially prioritizes stopping browsers, and resumes from a
durable cursor when a pass reaches its time budget. A stuck shutdown cannot take
priority over that cursor and starve other browsers. Queued work rechecks lifecycle
state, and deletion waits for actual attachments and saves to settle.
Sign-in requests retain live records and the 64 most recent terminal records.
Older requests become indexed retry receipts: their terminal outcome and linked
work remain available, while old diagnostics and control details expire. Listing
or watching browsers reads only live requests, and exact retries cannot reopen an
old request.
Once a new snapshot commits, deleting its predecessor runs separately with durable
retries. Slow cleanup does not turn a successful save into a failure or block stop.
Uploads rejected after cancellation, a lease change, deletion, or an upload
error enter the same durable cleanup queue. A temporary deletion failure retains
their addresses for retry while the last committed snapshot stays available.
Private diagnostics reuse a reference for repeated matching failures. Current
profile, instance and handoff references remain inspectable; obsolete entries
are trimmed to the latest 64 after saves and during maintenance. In-flight saves
retain their diagnostics until they settle. Each diagnostic is limited to 4,096
characters and eight causes, with a marker when details are truncated.

Inspect saved-state metadata on `gsv` with the existing browser commands:

```bash
browser profile list
browser profile get PROFILE_ID
```

`browser profile get` reports save status, timestamps, duration and raw/encrypted sizes.
`saveStatus: "partial"` means a snapshot was committed with site exceptions;
`issues` identifies each origin, reason, diagnostic and previous save time, if any.
`savedAt` describes the snapshot commit; an affected site's `retainedAt` describes
its older retained data. `browser profile get` exposes the exceptions.
Its `usage` field reports per-origin local storage and IndexedDB sizes, database and
record counts, and cookie counts/sizes by domain. Database details are capped at
32 entries and 4 KiB per origin; long names are shortened with an ellipsis.
`databaseUsageTruncated` marks shortened or omitted details. Cookie-domain
details are capped at 64 entries and 32 KiB, with `cookieDomainsTruncated` when
entries are omitted. The full usage breakdown is capped at 64 KiB. When it cannot
fit every site, it keeps the largest contributors, reports `sitesTruncated`, and
retains the total measured `siteCount`. Byte and record totals still include all
measured data for the corresponding profile, site or database.
These limits apply to metadata; website state keeps its ordinary storage allowance.
`browser profile list [--offset N]` returns at most 32 small summaries, the total
count and `nextOffset` when more remain. `browser profile get ID` returns that
profile's storage details and site exceptions.
Metadata contains no login values. Snapshot bytes and their encryption key remain
private to Instances. To forget saved logins, use
`browser profile delete PROFILE_ID`. This stops the browser using that state, fences pending saves and
erases its snapshots and key. Physical cleanup can continue while the profile
is marked `deleting`. The next ordinary start creates fresh state. Access follows
the same human owner and browser permissions as the browser API.

This does not copy your personal browser's passwords, extensions or passkeys.
Websites can expire a session or require another login. Device-bound sign-in,
security keys, downloads/uploads through the viewer, browser permission dialogs
and sites that reject cloud browsers may require a connected personal browser.
This is a website storage snapshot, not a complete Chrome user-data directory:
session storage, service-worker caches and filesystem-backed site storage are
not included. IndexedDB export supports binary buffers/views, dates, maps, sets,
bigints and cyclic values. Unsupported values, including CryptoKey and Blob
records, leave that site's previous saved data intact and report an exception.
They never silently become empty objects or prevent unrelated sites from saving.

Every instance has a fixed lifetime. Reusing it does not extend that lifetime
or reserve more time. Ship or you can stop it sooner with **stop browser**.
A stopped or failed instance stays terminal; another start creates another target
with a new eight-character ID. Export useful files before stopping: temporary
files disappear. Stopped browsers leave the ordinary Fleet list. `instance list
--all` includes your 64 most recently created terminal browsers alongside active
ones. Inventory omits per-site save issues; `instance get ID` retrieves recent
details. Older instances retain their identity, status and start-request receipts
for exact lookup and retries, while their runtime and detailed save diagnostics
are discarded. Saved website state and usage accounting remain separate.

A slow page or failed live frame does not by itself stop the browser. Health
checks run independently of page JavaScript, and temporary provider failures
have a one-minute recovery window within the original lifetime. A confirmed
missing session or a persistent failure stops the instance. Recovery never
repeats an agent action. Diagnostics identify the operation that timed out.

Ship can request an additional isolated browser with `--new`. It has a distinct
name and ID and is temporary: it does not share your saved logins or replace your
ordinary browser. Advanced `browser profile` commands remain available for
inspecting saved-state status and deleting saved logins. Deleting a profile
removes that state and stops any browser using it.

Starting reserves the requested lifetime against the space's monthly browser
allowance and concurrent instance limit. Usage counts from readiness until the
earlier of the fixed expiry deadline or confirmed termination, including time
spent signing in, capped at the reserved lifetime. Slow startup reduces the
usable time; cleanup after expiry never adds usage. Unused time is returned
after termination. An uncertain allocation
retains its reservation until cleanup can establish that it cannot still run.
When no session ID was received, the concurrency slot is released three minutes
after the acquisition attempt, covering its short provider keepalive; the requested
browser lifetime does not extend that grace period. The acquisition is never replayed.
A launch that never reaches readiness consumes no browser-time allowance; its
entire reservation is returned once cleanup completes.
Runtime spanning a UTC month boundary is settled into each month's allowance.
Runtime is rounded up once to seconds, capped by the reservation, with each
started second assigned to its starting month. Active reservations remain held
across rollover until termination is confirmed.

## Commands for Ship

These are commands on the native `gsv` target:

```bash
instance catalog
instance start browser --request-id <saved-request-id> --seconds 900 --wait
instance get <browser-id>
instance list
instance stop <browser-id> --wait
browser profile save <browser-id>
```

The result reports `disposition: created` or `reused`. `--wait` returns when the
browser is ready, with a default timeout of 60 seconds; `--timeout <milliseconds>`
sets a wait of up to 120 seconds. A timeout or cancellation stops waiting and
leaves the instance available for inspection by the saved request ID. Instance
commands accept either the displayed eight-character target ID or the full
instance ID. An unknown instance ID is an error, including for stop.
For stop, `--wait` returns after termination and release of the saved-state lease.
Ordinary stop fails if the final save fails. `instance stop <browser-id> --force
--wait` explicitly discards unsaved changes. `browser profile save` retries a save
and returns its status; instance results also include compact persistence status.

The ordinary start reuses the current browser. Retry a start rejected while
that browser is preparing to stop; its request ID
has not been committed to the stopping browser. If the stop's save fails, the
browser remains usable; after successful termination, a retry creates a new one.

Use tabs for additional work. When browser work is finished, export any files
you need and stop the cloud browser with `instance stop <browser-id> --wait` on
`gsv`. Keep it open if the user asks or ongoing work still needs it.
When an independent temporary browser is needed, request it explicitly:

```bash
instance start browser --new --name 'Separate research' --request-id <saved-request-id>
```

Persist a fresh start request ID before sending it. After a lost response, query
`instance get --request-id <saved-request-id>` or retry the same start with the
same arguments. Each request keeps its receipt even when it reused a browser.
To stop even if the start response was lost, use
`instance stop --request-id <saved-request-id>`. Never silently create a fresh
start after an uncertain response. Cancelling a tool's wait does not stop an
already admitted instance.

Once ready, use the returned target ID with ordinary Read, Write and Shell tools.
The cloud browser shares the extension's `tabs`, `page`, screenshots and
temporary filesystem commands. For example, run `tabs list` and `page snapshot`
on that target. It does not implement an operating-system shell.

If `tabs open` fails, including a navigation timeout, GSV closes the newly
created tab and reports the error. Existing tabs remain open, so retrying does
not accumulate tabs from failed attempts.

`tabs list` returns a bounded page with `count`, `total`, and `nextOffset` when
more tabs remain. Continue with `tabs list --offset <nextOffset>`. Titles, URLs
and list size are bounded; an ellipsis marks shortened display text. The cloud
browser's `/proc/tabs.json` exposes the first page and its pagination metadata.

Use `page fill` to replace a field value, including dates and times,
`page select` for native dropdowns, and `page check` for checked state.
These commands verify the result. Role/label locators, scoped snapshots and
action `--snapshot` avoid parsing reference IDs from filtered text. The action
receipt stays intact, followed by a readable outline; add `--json` when a
structured snapshot tree is needed. Use `--within` to inspect just the relevant
form or dialog, and `&&` between dependent actions so errors stop the sequence. See
[target tools](/reference/hardware-tools) and `page --help` for examples.

Visible dialogs appear at the top of a snapshot, with references even if the
outline reaches its display limit. Missing semantic locators also mention
visible dialogs. A dialog can hide background content from accessibility:
an empty filtered snapshot is a reason to inspect the dialog before searching
again, not evidence that the desired content does not exist.

`page screenshot` returns the path of a PNG on the browser target. To keep it
after the browser stops, run this on `gsv`, using the returned target and path:

```bash
cp <browser-target-id>:<screenshot-path> ~/screenshot.png
```

The saved file can then be inspected or attached like other files in your home.
Browser-local `cp`, pipes and redirection preserve binary file contents;
`/dev/null` discards output.

Cloud browser temporary storage allows 16 MiB per encoded file entry and 64 MiB
in total. Encoding and metadata count toward these limits. Transfers declaring
more than 16 MiB are rejected before their bodies are read; received bytes must
also match the declared length. A failed save leaves existing file contents
unchanged and does not publish a new file.
Reconnecting loads the temporary-file inventory without loading file contents;
bytes are read only when a command needs that file.

When login is needed, associate the request with the existing responsibility for
the task and yield after presenting the returned action link:

```bash
browser handoff request <instance-id> <tab-id> --request-id <saved-request-id> --purpose 'Sign in to the website' --work <responsibility-id>
browser handoff get <instance-id> <request-id>
```

Human completion or cancellation reopens the matching waiting responsibility.
Retrying the same completed request does not put the work back into waiting.
Cancelling or resolving the responsibility takes effect immediately. Its human
request is released in the background, normally within five seconds; a browser
service outage cannot prevent cancellation. Cleanup retries survive restart and
do not depend on the work's editable details. Browser stops, expiry and provider
failures also resume matching waiting work through this reconciliation, rather
than waiting for the original sign-in deadline. During a provider outage, retries
back off to at most one minute.
Its deadline also provides a durable recovery check if completion is interrupted.
After return, inspect the actual page before continuing. A disconnected browser
or uncertain click does not authorize repeating that click in another instance.

## Operator and development setup

`workers/instances` is an optional Worker implementing the public
`InstancesService` contract. Bind it to Gateway as `INSTANCES`. It owns a named
`InstanceCoordinator` Durable Object per immutable installation and an R2 bucket
of encrypted saved profiles. Browser Run credentials stay in its `BROWSER`
binding. Profile keys stay in the coordinator; object addresses and encryption
authentication include installation and human owner scope.

The first browser release creates its instance database with one initial SQL
migration. Earlier development checkpoints are not a supported upgrade path.
The Gateway separately applies its new browser-handoff-links migration to
existing spaces; previously shipped Gateway migrations remain unchanged.

Production configuration is disabled by default. Supply explicit `BROWSER_LIMITS`
or an `ENTITLEMENTS` service implementing these policy keys:

| Key | Meaning |
| --- | --- |
| `browser.enabled` | Admit browser starts |
| `browser.concurrent_instances` | Space-wide concurrent browser limit |
| `browser.period_seconds` | Monthly allowance, calendar month in UTC |
| `browser.max_instance_seconds` | Maximum lifetime for one instance |
| `browser.saved_profiles` | Space-wide saved profile count |
| `browser.profile_storage_bytes` | Maximum saved state bytes per profile |

The local default is 16 MiB of uncompressed serialized state per saved browser;
the service accepts an operator limit up to 32 MiB. Snapshots are compressed
before authenticated encryption, and unchanged state does not upload a new R2
revision. Usage metadata includes failed oversized attempts. Export bounds the
data transferred out of Chromium and restore bounds decompression. This allowance
does not guarantee that a website will preserve or accept a login.

Admission, reservations and settlement are owned by the instance service.
Provider billing reconciliation is separate from this customer allowance.
The public deployment composition accepts `services.instances` together with
`services.instancesLifecycle`: the instance Worker, entrypoint
`InstanceLifecycleEntrypoint`, and the `InstanceCoordinator` namespace of kind
`instance-installation`. Accounts receives the deletion binding with
`authority: "installation-deletion"`. An adopted operator composition must also
include its profile bucket and retained copies in its existing resource inventory.
The profile bucket uses `<installationId>/` as its storage prefix. Declare
`r2Prefix: "installation-root"` on both its `instances` resource scope and its
`cloudflare-r2-multipart` operator catalog entry so verification and multipart
capture inspect that exact prefix. Gateway buckets retain the default
`installations/<installationId>/` prefix.
Deletion closes admission, waits for termination, erases live state, and retains
the normal Durable Object backup retention receipt. Reset uses a new installation
identity and does not inherit these profiles.

Run `npm run dev`, then open `http://localhost:8976/admin` to create a local
space. Wrangler runs Chrome for Testing 145.0.7632.6 locally, matching the browser
version supported by the installed Cloudflare Playwright package. The first
start downloads and caches that browser. No paid remote browser is required for
the development flow.

Wrangler currently pins Chrome 126, which cannot position some modern calendar
popovers correctly. `npm run dev` loads a development-only shim that replaces that
version in Wrangler's Miniflare module without editing installed dependencies.
It fails explicitly if that internal declaration changes. To test another Chrome
for Testing build, set `GSV_DEV_BROWSER_VERSION` to its full version and restart
the stack. Existing browser sessions do not survive that restart; saved logins
remain in the local state directory. This setting does not change remote Browser
Run or the extension's browser.

After the server is ready, `npm run smoke:browser` creates
a clean local space and exercises concurrent start reuse, automatic saved logins,
cookie/local-storage/IndexedDB restoration, passive viewing, cursor reporting,
human input alongside agent work, input revocation, stop and saved-state deletion.
Login and live-view checks both use `sys.browser.watch`, the same streamed view
as Instrument. Checks cover following page commands, pinned tabs, rapid tab changes,
and closing the followed tab. Browser
artifact checks also cover screenshots, binary shell operations and file
transfers in both directions between the browser and `gsv`, nested web components,
calendar controls, popovers positioned with CSS anchors, verified form commands,
strict role/label lookup and scoped snapshots. A busy-page check verifies that
blocked page JavaScript does not stop the browser or block tab metadata. Browser
sessions can be lost when the Worker reloads, so finish builds before the smoke.

The local test does not establish that every real website accepts Cloudflare's
remote browsers. Validate intended sign-in providers on a development deployment
before enabling the feature for testers. Linux container instances are a separate
planned template and are not implemented by this Worker yet.

See [target tools](/reference/hardware-tools), [syscalls](/reference/syscalls),
[service contracts](/architecture/services), and
[Cloudflare's authentication persistence documentation](https://developers.cloudflare.com/browser-run/playwright/).
