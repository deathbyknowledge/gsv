# Use a cloud browser

A cloud browser lets Ship use websites while your personal devices are offline.
It appears in Fleet alongside your connected browsers and computers. Your
operator must enable cloud browsers; the local development stack enables them.

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

The view streams page changes as they happen. It drops superseded images when
the connection is slow, and reconnects after an interruption. Hidden views pause
capture; opening the view again resumes watching the same browser. Images use higher JPEG quality for clearer text. Network and website latency
still affect how quickly an action appears.

Sign in directly on the website in this view, including any verification code.
Ship can also request your help with a particular website. Open the request in
Ship, or follow its link from your messenger and sign in to GSV. For these
explicit requests, automation pauses until you choose **continue**, Ship cancels
the request, or it expires. Closing the viewer leaves the request available.
Requests expire after fifteen minutes or when the browser stops, whichever comes
first. The link identifies a request; it never grants access without your GSV
login. Your next chat message still goes to Ship. Website passwords and
verification codes belong in the browser view.

Passkeys and hardware security keys are unavailable in cloud browsers. GSV
reports this to websites before they can open an invisible native passkey
prompt that blocks page input. Choose the website's password or another
supported sign-in method. A site that requires a passkey needs your connected
personal browser.

## Remembered logins and lifetime

GSV automatically keeps website cookies, local storage and IndexedDB for your
local account in this space. The next ordinary browser restores that saved
state; there is no profile picker. Saved state is encrypted and separate from
the running browser. Only one instance can use the same saved state at a time.

GSV saves periodically, after human input settles, when you finish a login
handoff, and before an ordinary stop. Closing a website tab does not forget its
saved data. Restore completes before the next browser becomes ready. If restore
fails, that start fails visibly rather than opening an empty replacement.

A save waits for active browser commands and live-view input to settle. New
commands and input wait while the save completes, with their usual cancellation
and time limits. The live view stays open during saving.

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

Saved data is also inspectable on `gsv`, under your account name:

```text
/var/lib/gsv/browser/hank/
  README.txt
  status.json
  sites.json
  state.enc
```

`status.json` reports save status, timestamps, duration and raw/encrypted sizes.
`saveStatus: "partial"` means a snapshot was committed with site exceptions;
`issues` identifies each origin, reason, diagnostic and previous save time, if any.
`savedAt` describes the snapshot commit; an affected site's `retainedAt` describes
its older retained data. Both metadata files expose the exceptions.
`sites.json` reports per-origin local storage and IndexedDB sizes, database and
record counts, and cookie counts/sizes by domain. These files contain no login
values. `state.enc` is the opaque encrypted snapshot; its key stays with the
instance service, so copying the file alone is not a portable backup. The files
are read-only. Delete `state.enc`, or recursively remove your account directory,
to forget saved logins. This stops the browser using that state, fences pending
saves and erases its snapshots and key. Physical cleanup can continue after the
directory disappears. The next ordinary start creates fresh state. Access follows
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
files disappear. Stopped browsers leave the ordinary Fleet list, but their
records remain available through `instance list --all`.

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
allowance and concurrent instance limit. Usage counts from readiness until
confirmed termination, including time spent signing in, capped at the reserved
lifetime. Unused time is returned after termination. An uncertain allocation
retains its reservation until cleanup can establish that it cannot still run.

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

The ordinary start reuses the current browser. Use tabs for additional work and
close your task's tabs when finished. Do not stop a shared browser just because
one task ended. Stop an isolated browser you created when its work is finished.
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

When login is needed, associate the request with the existing responsibility for
the task and yield after presenting the returned action link:

```bash
browser handoff request <instance-id> <tab-id> --request-id <saved-request-id> --purpose 'Sign in to the website' --work <responsibility-id>
browser handoff get <instance-id> <request-id>
```

Human completion or cancellation reopens the matching waiting responsibility.
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
Live-view checks cover following page commands, pinned tabs, rapid tab changes,
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
