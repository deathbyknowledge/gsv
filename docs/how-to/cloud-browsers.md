# Use a cloud browser

A cloud browser lets Ship use websites while your personal devices are offline.
It appears in Fleet alongside your connected browsers and computers. Your
operator must enable cloud browsers; the local development stack enables them.

## Start and sign in

1. Open **Fleet → start browser**.
2. Choose a saved profile, or create one to remember website logins. A temporary
   browser forgets its logins when it stops.
3. Start the browser, select it in Fleet, and open a website.
4. Choose **use browser**. Sign in directly in the browser view, including any
   verification code the website requests. The tab selector includes login popups.
5. Choose **Done — return to Ship** when finished.

Ship can also request your help with a particular website. Open the browser
request shown in Ship, or follow its link from your messenger and sign in to GSV.
The link identifies a request; it does not grant access without your GSV login.
Your next chat message still goes to Ship. Website passwords and verification
codes belong in the browser view.

Automation on this browser pauses while you control it. Other GSV work can
continue. Done closes human input before the browser resumes automation. Cancel
ends the handoff without claiming that you completed the requested sign-in.
Requests expire after fifteen minutes or when the browser stops, whichever comes
first. Closing the viewer with Cancel ends the request; closing the whole GSV
tab leaves it available until you reopen it or it expires.

## Remembered logins and lifetime

A saved profile stores website cookies, local storage and IndexedDB. It is
separate from any one running browser. Only one browser can use a profile at a
time. Fleet shows whether its most recent save succeeded. Choose the same
profile when starting the next browser to restore the saved state.

This does not copy your personal browser's passwords, extensions or passkeys.
Websites can expire a session or require another login. Device-bound sign-in,
security keys, downloads/uploads through the viewer, browser permission dialogs
and sites that reject cloud browsers may require a connected personal browser.

Every instance has a fixed lifetime. Ship or you can stop it sooner with
**stop browser**. A stopped or failed instance stays terminal; another start
creates another target. Temporary files and unsaved website state disappear.
Export useful files before stopping. Deleting a saved profile removes its stored
login state and stops any browser using it.

Starting reserves the requested lifetime against the space's monthly browser
allowance and concurrent instance limit. Usage counts from readiness until
confirmed termination, including time spent signing in, capped at the reserved
lifetime. Unused time is returned after termination. An uncertain allocation
retains its reservation until cleanup can establish that it cannot still run.

## Commands for Ship

These are commands on the native `gsv` target:

```bash
instance catalog
browser profile create Personal --request-id <saved-request-id>
instance start browser --request-id <saved-request-id> --profile <profile-id> --seconds 900
instance get <instance-id>
instance list
instance stop <instance-id>
```

Persist a fresh start request ID before sending it. After a lost response, query
`instance get --request-id <saved-request-id>` or retry the same start with the
same arguments. To stop even if the start response was lost, use
`instance stop --request-id <saved-request-id>`. Never silently create a fresh
start after an uncertain response. Cancelling a tool's wait does not stop an
already admitted instance.

Once ready, use the returned target ID with ordinary Read, Write and Shell tools.
The cloud browser shares the extension's `tabs`, `page`, screenshots and
temporary filesystem commands. For example, run `tabs list` and `page snapshot`
on that target. It does not implement an operating-system shell.

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
space. Wrangler runs Chromium locally. No paid remote browser is required for
the development flow. After the server is ready, `npm run smoke:browser` creates
a clean local space and exercises sign-in, cookie/local-storage/IndexedDB
restoration, human control revocation, stop and profile deletion. Browser
sessions can be lost when the Worker reloads, so finish builds before the smoke.

The local test does not establish that every real website accepts Cloudflare's
remote browsers. Validate intended sign-in providers on a development deployment
before enabling the feature for testers. Linux container instances are a separate
planned template and are not implemented by this Worker yet.

See [target tools](/reference/hardware-tools), [syscalls](/reference/syscalls),
[service contracts](/architecture/services), and
[Cloudflare's authentication persistence documentation](https://developers.cloudflare.com/browser-run/playwright/).
