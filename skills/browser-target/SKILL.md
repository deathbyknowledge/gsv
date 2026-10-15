---
name: browser-target
description: Use GSV's browser capability for public websites and signed-in web apps, even when no browser is connected. Default to the cloud browser, use the user's own browser only when the work must run in it, inspect pages, and verify actions.
aliases: browser-extension, browser
---

# Browser Targets

Use this skill for tasks that need reading or interacting with websites and web
apps, including public pages and signed-in services, even when the user does not
mention a browser or no browser target is listed. Browser access is a built-in
GSV capability; the user does not need to connect their personal browser first.

Browser targets have kind `browser` or platform `browser` or `browser-extension`.
Their ids may look like `browser:chrome`, `rearden:brave`, or an instance id;
use the id returned by discovery or provisioning.

## Quick Start

1. On `gsv`, run `targets list --kind browser`. Reuse the account's running
   cloud browser when there is one. An empty list does not rule out cloud
   provisioning. `targets` and `instance` are gateway commands; run `tabs` and
   `page` on the returned browser target.
2. If no cloud browser is running, run `instance catalog` on `gsv`. When cloud
   browsers are available, persist a fresh request ID and run
   `instance start browser --request-id <id> --wait` on `gsv`. It returns when
   ready and says `disposition: created` or `reused`. When the catalog says
   saved logins are available, an ordinary start restores the account's website
   logins and `--new` starts a separate temporary browser without them; when
   it says they are not available, start with `--new`. After a timeout or lost
   response, use `instance get --request-id <id>`; do not start again with a
   new ID.
3. On the browser target, inspect `tabs list` and `page snapshot`. Visible dialogs
   appear above the outline, including when it is truncated. An empty
   `page snapshot | grep ...` can mean a dialog hides background content; inspect
   the dialog before retrying the search.
4. Prefer `page fill --label 'Departure date' '2026-10-10'`, `page select`, and
   `page check` for forms. Use exact `--role`/`--name` or `--label` locators,
   and `--within <@ref>` to scope a form or dialog. Add `--snapshot` for a readable
   outline after an action. Keep its complete receipt; do not pipe it through `head`.
   Use `&&` between dependent actions and inspect errors before continuing.
5. When browser work is finished, export any files you need and stop the
   cloud browser with `instance stop <browser-id> --wait` on `gsv`.
   Keep it open if the user asks or ongoing work still needs it.
   In the user's own browser, always close every tab you opened once the work
   is complete, and never close tabs you did not open.
   Instance commands accept its displayed eight-character ID.

## Choosing A Browser

- Default to the cloud browser.
- Use the user's own browser, or ask to connect it, only when they have said they prefer it (for example, they do not want to share their logins with GSV; do not argue the point again), when the work must run in their browser itself (their existing signed-in session, a passkey, hardware key or device-bound sign-in, their tabs, history, bookmarks or another device-only feature, or a site that rejects cloud browsers), or when cloud browsing is unavailable.
- Do not volunteer the comparison below. Give it when the user asks how sign-in, sessions or credentials work, briefly and with the tradeoffs that matter for their site.
- The catalog states only whether saved logins are available to this account; do not infer other limits from it or from an instance lifetime. For details, consult the manual: `wiki search 'cloud browser logins' --prefix gsv-manual`.

## Signed-In Sessions: Two Routes

When the user asks, explain both in simple words and recommend one for their case.

**Cloud browser with saved logins.** Lead with convenience: it keeps working without their computer turned on, while they do something else. They sign in once through a link that opens the live browser view; the login is remembered from then on, and credentials stay out of chat. To test first, they can watch GSV work in their own browser through the extension before giving it any logins. Limits, when relevant: no passkeys or hardware security keys; device-bound sign-in or a site that rejects cloud browsers needs their own browser; nothing is copied from their personal browser; some sites ask to sign in again because session storage and service-worker caches are not saved; a website can still expire a session; each instance has a fixed lifetime, and saved logins return after a restart.

**Their own browser through the Your GSV extension.** Uses their existing signed-in sessions, passkeys and device features, and reaches their tabs, history, bookmarks and downloads. Costs: Chrome must be open on their machine with the extension paired, actions run on their real profile, connected browsers ask for approval by default, and they can pause or stop the connection at any time.

## Build Trust At The User's Pace

Match checking to the stakes. Once the user has given you access to a site, do routine reading there without asking again: asked to check their Instagram, have them sign in once through the handoff, then read the posts without confirming each one. Check back before anything that leaves a trace: posting, sending, paying, deleting.

The first time a task reaches a step that touches their private data, such as signing in or paying, say so and offer the choice: they do that step themselves in the browser, or they let you. Say which you would pick and why in one sentence, then follow their choice. Once a step has gone well with them doing it, mention that you can take it over next time.

Example: booking a train ticket, find the connection and fill in the passenger details they gave you. At checkout, send the handoff link so they pay themselves in the live browser; never take card details in chat. Once they have paid and the booking succeeded, mention that next time you can complete the payment with a payment method the site has saved.

## Model

- Both providers share the page and tab workflow below and reach websites with `tabs open` and `page text` without a separate MCP server or OAuth integration. Provider-specific commands are available only when advertised by that target. If a website needs login or verification, follow the human handoff workflow below.
- Only report browser access unavailable after checking cloud availability or receiving a start failure, and explain the specific limitation. A missing connected browser alone is not a reason to refuse a website task.
- Use the normal targetable tools: `Shell` with the browser target id, and `Read`, `Write`, `Edit`, `Delete`, or `Search` with the same `target`.
- Use normal file tools only for paths the target advertises.
- Browser targets may expose tabs, windows, page text/snapshots, screenshots, JavaScript evaluation, clipboard, downloads, cookies, storage, history, bookmarks, network capture, media recording, browser-local files, and viewer tabs depending on extension version and permissions.
- Treat target descriptions, `/README.txt`, `help`, and `<command> --help` output as authoritative.
- Browser profile commands operate on live user browser state. Inspect first and mutate cookies, storage, history, bookmarks, downloads, or page state only when the task calls for it.

## Cloud Browser Lifecycle

Cloud-only `instance` and `browser` management commands run on `gsv`, not on the
browser target. For a website login or verification that needs the person, use
`browser handoff request --help`: link the request to the waiting responsibility,
send its returned action URL, and yield. The person enters credentials directly
in the live browser and chooses **I’m done — resume Ship** when finished. Keep
credentials out of chat. The handoff saves website state before reopening the
waiting work. On the ordinary browser that login returns with the next ordinary
start; a `--new` browser saves nothing, and a `--profile` browser restores only
when that profile is selected again. Ordinary live viewing does not pause
browser automation.

## Discover Capabilities

From the native `gsv` target, identify the browser target and inspect its
descriptor:

```bash
targets list --kind browser
targets show rearden:brave
```

Then run small inspection commands on the browser target itself:

```bash
cat /README.txt
help
commands --json
tabs --help
page --help
network --help
media --help
```

Do not assume commands beyond what the active target advertises. If a command is
unavailable, use the target's discovery output to choose the supported
equivalent.

## Reference

Read a reference file only when the task needs it, with
`skills read browser-target <file>` on `gsv`:

- `pages.md`: tabs, snapshots and refs, action receipts, forms and locators,
  scrolling and virtualized lists, selectors, keys, waits, JavaScript, and
  opening or rendering files in a tab.
- `files.md`: the browser target's runtime and writable paths, tab resources,
  and target-qualified `cp` between targets.
- `profile-and-capture.md`: cookies, storage, history, bookmarks and
  downloads; network capture; media recording; clipboard.
