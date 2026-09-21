# Isolated Tauri prototype

Status: implementation experiment, based on `origin/main` at `e917c3f4` on
2026-09-21. This does not adopt a production Desktop cutover.

## Ownership

The app hosts the packaged, existing Instrument frontend, including Zen, its
canonical Conversation reader, Process observation, approvals, and optimistic
outbox. The JavaScript GSV client owns the sole authenticated gateway connection.
Rust does not run the GPUI conversation engine. The gateway still authorizes all
syscalls; the native bridge does not expose shell or filesystem operations.

Rust owns the transcription and vision supervisors, native input authority,
helper cancellation, window lifecycle, and a private prototype credential file.
The same supervisor source is shared with GPUI through `desktop-native`.
Microphone audio and camera frames remain in the existing helpers.

## Isolation and session lifetime

The application is `GSV Tauri Prototype`, identifier
`es.humansandmachines.gsv.tauri-prototype`, with its own application data directory.
It never reads or writes the installed Desktop's config or local IPC endpoint.
There is one configured gateway. Reconfiguration clears credentials and causes a
complete frontend teardown/reload, including session storage, query clients,
outbox, uploads, draft and terminal journals. Ordinary unsent-work warnings still
apply. User client credentials never become machine credentials.

The host validates an HTTPS origin (HTTP loopback is permitted for development),
stores credentials with that origin and a random configuration generation, and
rejects writes from earlier generations. Account identity remains in the issued
session credential. No installation ID is supplied by the client. The frontend
necessarily receives its session token because it owns authenticated transport;
host persistence protects the file boundary, not secrets from trusted app code.

Only the bundled main window can invoke explicitly listed application commands.
No remote capability, general filesystem, shell plugin, or disabled web security
is used. HTTP(S) links open in the external browser. OAuth and recovery complete
in the chosen gateway's browser UI; there is no prototype deep-link receiver.

## Input lifetime

Every active Zen workspace attaches a fresh native lease. The host validates the
lease, helper session, voice request, segment, sequence and event age. It keeps
replace-latest partial/status/scroll state and a bounded acknowledged lane for
semantic completion. JavaScript applies correlated text through the real composer
and submits through Zen's ordinary outbox. Sending a dictation segment never
interprets dictated text as a direct shell command.

The native watchdog revokes authority when the frontend stops acknowledging.
Unfocused operation can continue while the webview is responsive. A suspended or
heavily throttled webview cancels voice and disarms gestures; it cannot replay old
send/delete actions on return. Full minimized dictation through webview suspension
is a prototype limitation to compare on Linux/WebKitGTK and macOS/WKWebView.
Reload, process selection change, logout, helper failure and Quit cancel input.

## Implementation batches and shared files

1. Extract existing native supervisors without changing their helper protocols.
2. Add the isolated Tauri host, explicit command permissions, and single-gateway
   persistence. Inject URL/storage into the existing session service and reuse
   App/Instrument.
3. Add the small native-input platform seam to Zen/PromptLine, real helper state,
   gesture actions, and native lifecycle.
4. Supply user-run build/launch instructions, focused acceptance scenarios and
   an opt-in CI artifact workflow. Production releases and installers stay owned
   by their existing paths.

Likely shared-file conflicts: `App.tsx`, `AppProviders.tsx`, `sessionService.ts`,
`GatewayProvider.tsx`, `Zen.tsx`, `PromptLine.tsx`, `host/Cargo.lock`. No social,
adapter, gateway policy, prompt or standing-context work belongs in this batch.

The handoff initially deferred local verification to the user/CI. The user then
explicitly authorized local compilation and launch on 2026-09-21, with the user
acting as the testing proxy and entering their own production space. No local
test suites, lint, automated interaction or production probes are run.

Framework references: [Tauri capabilities](https://v2.tauri.app/security/capabilities/),
[application command manifest](https://docs.rs/tauri-build/latest/tauri_build/struct.AppManifest.html),
[Vite integration](https://v2.tauri.app/start/frontend/vite/),
[window configuration](https://v2.tauri.app/reference/config/).

## Zen refinement, 2026-09-21

The first human pass confirmed functional dictation and gestures, but reported
soft text at 200% and roughly 100–200 ms of perceived keyboard/typing latency.
That is the human baseline, not an instrumented latency measurement. The running
window stays untouched while the next build is prepared.

The shared Instrument owns crisp layout zoom and immediate view navigation.
Zen owns immediate typing, selection and scroll anchoring. Native input retains
its existing lease/acknowledgement and cancellation boundaries, but its changing
presentation must not rerender the transcript. Decorations must not compete with
input by laying out a screen-sized text grid on every animation frame.

The interaction design keeps the prompt exclusively for the person's draft.
Voice and Gestures sit beside Attach as quiet, named disclosures. Their labels
show active microphone/camera state; a recognized gesture gets a short action
label and a hold indicator in that same affordance. One panel opens at a time,
above the composer without resizing the conversation. Voice contains start,
pause/resume, finish and microphone choice. Gestures contains camera control,
explicit arming, and a compact hand guide. Only errors demand additional space.
Opening either panel never starts a sensor. Closing it never stops a sensor;
the active indicator and explicit stop controls remain available.

No feedback or guide text is inserted into the draft, and no extra model or
gateway request is needed for input presentation. Ordinary typing, Enter,
attachments and gesture send retain the existing conversation owner.

Source findings in the first build: navigation explicitly waits 150 ms; native input supplies a
fresh state object every 100 ms; every draft character updates Zen; prompt
measurement repeats synchronous layout reads/writes; and the star field replaces
its entire text grid at 24 Hz. These justify the bounded changes above, but do
not establish their share of observed latency. The XWayland/shared-memory launch
workaround remains another variable for a later human comparison.

The replacement native bridge uses a private Tauri channel established by the
authorized attach command. Rust pushes changed state with a monotonic delivery
revision and emission time. At most one update is in flight; newer partials and
gesture status replace pending state while completion events stay in the bounded
acknowledged lane. The frontend acknowledges after applying a delivery. A quiet
one-second keepalive checks the lease but returns no state and causes no render.
Unconsumed delivery, expired leases, stale emission times, scope changes and
teardown still revoke input. Scroll updates retain source age and sequence so
steady movement can refresh its freshness without rerendering the controls.
The former polling command and capability are removed.

The shared star field retains its seed, density, glyphs and palette, but caches
positioned stars instead of rebuilding empty cells. Only changed glyphs are
written, at most eight times per second, with half-speed twinkling and no
animation while hidden, unfocused, offscreen, or under reduced motion. Shared
message bodies, timestamps and receipts reuse their output when their inputs
are unchanged. Prompt measurement is coalesced into one frame and dirty-state
notification only changes when the draft becomes empty/nonempty.

The old maintainer comment above `.instrument-scaled` describes transform
scaling; it is preserved and followed by a note explaining the replacement.

Prototype diagnostics expose `window.gsvInputTiming.read()` in the inspector.
Only bounded keyboard/input dispatch and next-frame timings are retained in
memory. No keys, text, targets or private content are recorded or transmitted.
These timings do not measure final GPU/compositor presentation latency.

## Second human pass: layout regressions and remaining latency

The user reported that 150%/200% zoom shrank the UI into a corner while the
unscaled field still covered the window, and that the gesture panel was only
about one line tall. The scaled layer now uses absolute insets with automatic
width/height instead of retaining the transform-era divided viewport dimensions.
Its parent owns the available rectangle, including the prototype bar offset.
Layout zoom still owns text sizing and container-query reflow.

The native panel's percentage height had resolved against the positioned
`.zen-bottom` composer, not the full Zen area. Zen now owns a full-area overlay
host outside the composer. Native controls portal their one open panel into it;
the overlay reserves header and bottom-control space, and the panel scrolls
only when its content exceeds that area. This keeps input state in the native
controls and preserves the place picker's existing footer anchor.

The user also confirmed sluggish input/navigation with both sensors off.
The remaining delay is not attributed to a measured frontend bottleneck yet.
The required local `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1` workaround is a concrete
candidate: WebKitGTK 2.52.6's
[`RenderTargetSHMImage::didRenderFrame`](https://github.com/WebKit/WebKit/blob/webkitgtk-2.52.6/Source/WebKit/WebProcess/WebPage/CoordinatedGraphics/AcceleratedSurface.cpp#L514)
reads the whole framebuffer with `glReadPixels` on each rendered frame.
Caching glyph layout does not remove that transport cost. Human timing and
renderer comparisons are still needed before claiming a cause or another
performance improvement.

The next observation further narrows the comparison: wheel scrolling feels
immediate, while keyboard scrolling and showing the custom prompt caret after
a click take about 150–200 ms. That prioritizes the main-thread event, component
and layout path; the framebuffer-copy cost alone does not explain the contrast.
No intentional 150 ms delay remains in those source paths.

The prototype bar exposes the existing bounded timing samples through a quiet
Timings disclosure, including prompt clicks. Reading or clearing the report is
on demand and starts no polling or render loop. The report includes only timing
aggregates and window/layout dimensions. It can distinguish delayed dispatch
from delayed animation-frame scheduling, but it ends before paint and cannot
prove end-to-end latency. Copying is an explicit local clipboard action, with
selectable report text if clipboard access is unavailable.

The prototype strip is outside Instrument's theme. It must set its own foreground
and background colors; relying on inherited text color left its actions dark on
the dark page. F8 also opens the timing report directly, including while the
prompt is focused, without inserting text or changing the active space.

## First timing report: keyboard scheduling

The human report at 200% layout zoom contained 200 keyboard samples: 4 ms p95
dispatch, 74 ms p95 to the next animation callback, and a 347 ms maximum. The
smaller typing sample (12 events) reached that callback within 14 ms; the two
prompt clicks took 8 ms. Instrument and its scaled layer both occupied the full
2102 by 2076 available rectangle; the scaled layer's layout dimensions were
1051 by 1038, consistent with 200% layout zoom. These numbers support investigating
the keyboard path, but do not separate JavaScript work from rendering/scheduling
or establish when the custom caret reached the display. The original keyboard
bucket included all key presses, not just browsing.

Zen still rebuilt every message's surrounding UI on each browse selection, even
though text and receipts were individually memoized. Message content now reuses
its complete virtual-node subtree while its inputs are unchanged; the browse
cursor and focus decoration remain independent. Content, activity, approval,
outbox, animation and attribution changes retain their existing update paths.

Scroll ownership stays in `useZenScroll`. It refreshes its node index when the
transcript changes, resolves selected and anchored rows by identity, and finds
the first visible row with a binary search over transcript order. Row geometry
is read when needed rather than cached across resizing, streaming or expansion.
This replaces repeated DOM queries and linear geometry scans per navigation.

The timing report now includes a separate j/k browse category alongside the
original aggregate keyboard category. It retains only the category and timings,
never individual keys or text. The next human pass should compare j/k at the
same zoom and window size, including long messages, older-page loading, expanded
receipts and returning from the prompt. Source inspection and compilation do not
establish a latency improvement; a fresh report is still needed.

## Second timing report: separate navigation from typing

The next human report had 38 navigation samples with 82 ms p95 dispatch, 109 ms
p95 to the next animation callback and a 145 ms maximum. Its 103 input events
took at most 17 ms to that callback. The aggregate keyboard p95 was only 19 ms,
because navigation was a minority of the 150 keyboard samples. It must not be
treated as a like-for-like improvement from 74 ms: the earlier report had no
navigation category and the window width also changed from 2102 to 1901.
There were no matching prompt pointer-down samples in this report.

The delay before the capture listener runs can include work left over from a
previous interaction or platform/renderer event delivery. The existing report
does not establish the cost of the current navigation handler or a Preact
update, and p95 over 38 samples describes the slow end rather than a typical
press. The next diagnostic build retains medians and separates initial j/k
presses from auto-repeat events.

The shared browse handler emits one static-name User Timing measure for its
synchronous selection and scroll work, immediately removing it from the global
performance timeline. The prototype's observer retains only bounded durations.
The prototype also wraps Preact's public update scheduler, preserving the
installed scheduler or the current source's Promise-microtask default. It
measures queue wait and update-flush duration only while navigation samples
await their first animation callback. That flush includes component work and
layout effects; it can include concurrent updates, and excludes later paint or
GPU presentation. Phase percentiles describe different samples and must not be
added or subtracted to assign the delay. A report includes the loaded row count
without identities, text or other conversation data.

The next human comparison should keep the current zoom/window size, pause
between individual taps, then hold each browse key briefly before repeating
the prompt input pass. This batch adds measurements; it does not claim another
latency fix.

The user reports that this build feels responsive. The aggregate also bounds
the frequency of the outliers: these 38 navigation samples are a subset of 150
keyboard samples, below the 200-sample cap. A keyboard p95 of 19 ms means at
least 31 of the 38 navigation samples reached the next callback within roughly
19 ms. The tail does not imply a consistent 109 ms delay. Further diagnostics
are optional; this report alone is not a reason for another performance change.

## Prompt cursor responsiveness

The user finds typing and arrow movement slightly less responsive than the
improved conversation browsing. The old next-frame sample ends in a callback
registered by the document capture listener, before PromptLine's own scheduled
measurement and component update. Its 16–17 ms typing result therefore did not
establish that the visible cursor had caught up.

PromptLine owns the block caret and its correspondence to the textarea's native
selection. Its cursor refresh listened to keyup, click and select, but not
selectionchange or navigation keydown. In the installed WebKitGTK 2.52.6 source,
[selectionChanged](https://github.com/WebKit/WebKit/blob/webkitgtk-2.52.6/Source/WebCore/html/HTMLTextFormControlElement.cpp#L526)
dispatches select only for a non-collapsed selection. Ordinary arrow movement
could therefore leave the block at its old position until key release. The
independent one-second blink was also never reset on movement, allowing the
block to move during its half-second invisible phase.

The shared prompt now subscribes to textarea selectionchange and schedules a
refresh on Arrow/Home/End keydown, after the browser's default action, including
auto-repeat. The measurement applies the caret's transform and visibility
directly instead of scheduling another component render. The mirror retains its
text nodes and marker, and caret-only movement does not remeasure textarea
height. Editing resets the existing blink to its visible phase; unfocused
carets pause it, and reduced motion retains the existing no-animation rule.
The browser still owns text editing, selection, composition and keyboard
movement; PromptLine owns presentation and preserves its submit/history/picker
interception contracts.

Prototype reports retain bounded, static-name durations for prompt measurement,
input-event-to-caret refresh and Arrow/Home/End-keydown-to-caret refresh. They
end after geometry and cursor styles are applied, before painting and display.
They retain no text, raw keys or selection positions. Coalesced events share the
same refresh endpoint; an earlier synchronous refresh can already have applied
the position. Compilation does not establish the improvement: the next human
pass should compare typing, tapped and held arrows, selection with Shift,
wrapped/multiline drafts, cursor movement after an idle blink, and prompt focus
at the current zoom. The running testing window remains untouched.

## Retain view state across navigation

The browser and Tauri entries import the same Instrument, Zen, Fleet, Memory,
Settings and prompt components. These fixes are shared source changes on the
prototype branch; the deployed browser and existing GPUI application do not
change merely because a prototype executable is rebuilt.

Instrument previously unmounted a screen on every view change. Its discard
dialogs protected real loss of drafts, forms and reading position. It now
mounts each screen lazily and retains it for the signed-in session. Ordinary
view switches require no confirmation. Replacing an edited page, starting a
different conversation/composer action, sign-out and reload still protect work
that those actions would discard. Retention neither submits forms nor writes
drafts or credential fields into persistent storage. Existing gateway/account
session teardown also tears down the retained views.

The shared navigation service exposes view activity. Hidden query observers
stay attached to retain the cache entries they own, but disable fetching and
UI notifications. Reopening observes the latest cache and performs ordinary
stale-data recovery. Conversation signals continue merging into the existing
runtime without publishing hidden transcript renders; Process history retains
its existing signal owner. Terminal sessions also remain owned above the views,
with visual subscriptions limited to active consumers. In-flight sends and
explicit mutations may complete while away.

Hidden views release keyboard/paste handlers and geometry observers, pause
visual clocks and model sign-in polling, and avoid reading zero-sized layout.
Zen retains scroll anchors and refreshes prompt geometry when shown. Hiding Zen
releases native input just as its old unmount did; returning does not restart
microphone or camera capture. Visited DOM, local state and observed cache data
cost additional memory. No benchmark or zero-cost claim follows from retention.

Regression coverage is authored for lazy lifetime, draft retention, hidden
signal accumulation, and disabled query notifications/invalidation reads. It
has not been run locally under the human-testing workflow. The next acceptance
pass should cover drafts, selected items and scroll in all four views, live
replies arriving while away, and input responsiveness after visiting them all.
