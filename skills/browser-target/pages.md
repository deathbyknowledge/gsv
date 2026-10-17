# Pages and Tabs

Reference for the shared page and tab commands on a browser target. Read it
from the browser-target skill when you need ref, receipt, form, scrolling,
virtualized-list, selector or JavaScript details beyond the Quick Start.

## Contents

- Tab discovery and snapshots
- Refs and when they expire
- Action receipts: delivered and observed
- Forms: fill, select, check, locators and --within
- Scrolling and virtualized lists
- Selectors, keys, waits and JavaScript
- Opening tabs and rendering files

## Commands

Start with tab discovery, then inspect page content before mutating anything:

```bash
tabs list
tabs active
page snapshot --tab <tabId>
page text --tab <tabId>
```

`page snapshot` returns a readable accessibility outline. Actionable elements
and scroll regions carry snapshot-scoped refs such as `@s4k2e7`. The leading
`@` is part of the canonical ref; commands also accept the bare generated form
`s4k2e7`. Refs are pinned to the tab and document that produced them:

```text
textbox @s4k2e1 "Search or start new chat"
scroll-region @s4k2e2 "English Mamá: Hello" [scrollable=y]
  row @s4k2e3 "English"
textbox @s4k2e4 "Type a message" [editable focusable]
```

```bash
page click --tab <tabId> @s4k2e3
page type --tab <tabId> @s4k2e4 'Draft text'
page scroll --tab <tabId> @s4k2e2 down
page scroll --tab <tabId> @s4k2e2 top
```

Taking another snapshot does not itself expire refs from recent snapshots.
Refs expire when their bounded snapshot is evicted, the extension restarts, the
node disappears, its semantics change, or its document navigates. If an action
reports an unknown or stale ref, take a new snapshot instead of guessing which
element replaced it. Prefer the newest refs for virtualized rows because a
framework may reuse a node for different content.

Page actions return compact JSON with separate `delivered` and `observed`
sections. `delivered.accepted` means Chrome accepted the CDP input, and
`delivered.receiver` identifies the hit-tested or focused receiver.
`observed.status` is `changed` or `no-change-detected`; observation covers
navigation, focus, selection, DOM mutations, and target state. Accepted input
with no detected change may be a no-op or an effect outside the observer;
inspect the warning and snapshot again rather than treating it as a transport
failure.

For forms, prefer verified value-setting commands. `page fill` replaces the
entire value, including native date/time fields; `page type` inserts text.
`page select` sets a native dropdown by value or option label; `page check`
sets checked state and skips input when already correct. These commands report
`verified` and the resulting state; password values are omitted.

```bash
page fill --tab <tabId> --label 'From' 'Amsterdam Centraal'
page fill --tab <tabId> --role input-time '10:00'
page select --tab <tabId> --label Class --option-label First
page check --tab <tabId> --label 'Direct only'
page click --tab <tabId> --role button --name Plan --snapshot
```

Role/name and label locators resolve against the current page and require one
match. Ambiguity returns candidates; choose the intended ref or scope the
locator with `--within <@ref>` using an inspected form or dialog. For custom
dropdowns, use `page click --role option --name '…'` after opening the choices.
`page wait` accepts the same semantic locators.

Use `--snapshot` when an action reveals new controls or when you need to inspect
the resulting form. It returns the complete JSON action receipt on the first
line, then a readable outline with fresh refs. `--within` scopes both lookup and
the follow-up snapshot. Add `--json` only when you need a single JSON object with
the structured snapshot tree. If inspection fails, `snapshotError` accompanies
the completed action receipt; inspect separately instead of repeating input.
For simple verified value changes, the receipt is usually enough.

`page snapshot --within <@ref>` keeps inspection focused. Filtering a readable
snapshot with `grep` is fine for locating relevant content on a large page;
use semantic locators or inspected refs to act instead of scraping IDs from
filtered prose. Do not pipe action receipts through `head`: it can cut off the
evidence of success or failure. Chain dependent actions with `&&`, not `;`:

```bash
page fill --tab <tabId> --label Notes 'Draft text' && page check --tab <tabId> --label 'Save draft'
```

If you must pipe an action, enable `set -o pipefail` so a pipe reader's success
cannot hide the action's failure. Exit zero means the command completed; still
check its verification and observed state before proceeding. Use `page wait`
for the expected control instead of fixed sleeps.

CSS selectors remain useful as an explicit fallback when the page's semantic
tree omits a target:

```bash
page click --tab <tabId> 'button[type=submit]'
page type --tab <tabId> 'input[name=email]' 'hank@example.com'
page key --tab <tabId> Enter
page wait --tab <tabId> '.result' --timeout 10000
page screenshot --tab <tabId>
```

Selector clicks and typing still use Chrome's input pipeline. Use
`page snapshot --dom [selector]` for a bounded raw-DOM debugging view when
semantic names are insufficient. Use a snapshot ref with `page scroll` to
target nested virtualized lists; an untargeted scroll acts at the viewport
center and may be received by whichever scrollable element is under that point.
Targeted `top` and `bottom` repeat native wheel input and report
`observed.scroll.boundaryReached`; check that field instead of assuming an
accepted wheel event reached the boundary. If the target is already there, the
action reports `delivered.skipped=already-at-boundary` with zero events and
does not dispatch input.

Virtualized lists expose only their currently materialized rows. To read one
completely, record the visible semantic rows, scroll the list by its ref,
snapshot again, and deduplicate rows until the reported scroll position stops
changing. Use refs from the newest snapshot for row actions because frameworks
may reuse one DOM node for different rows after scrolling.

`page type` inserts text but does not submit a form or send a message. Treat
Enter, submit buttons, and send controls as separate mutations and invoke them
only when the task authorizes submission.

Use JavaScript evaluation only when page snapshot/text/click/fill/select/check/type/wait cannot
express the task:

```bash
page js --tab <tabId> 'document.title'
page js --tab <tabId> 'Array.from(document.querySelectorAll("button")).map((button) => button.textContent)'
```

Prefer semantic refs, then selectors, over coordinates. Always pass `--tab` for
work on an agent-opened tab so a user changing their active tab cannot redirect
selector, key, screenshot, text, wait, or JavaScript commands. Ref actions also
validate that an explicitly supplied tab matches the ref's original tab.

`tabs open` creates a background tab and returns its id. Capture that id and
pass it to every command that operates on the new tab:

```bash
opened="$(tabs open https://example.com)"
tab_id="$(printf '%s\n' "$opened" | tail -n 1 | jq -r '.tab.id')"
page snapshot --tab "$tab_id"
page click --tab "$tab_id" 'a.more-information'
```

Use `tabs open --active` only when the user explicitly asks to see or switch to
new content. For example:

```bash
tabs open --active /home/browser/screenshots/tab-123.png
printf '<h1>Report</h1>' | tabs open --active --mime text/html -
```

For a remote file, first copy it into `/tmp` or `/tmp/render` on the browser
target from the native GSV shell, then run `tabs open` on the browser-local
path. Use `--mime` when stdin or an extensionless file needs an explicit
content type.
