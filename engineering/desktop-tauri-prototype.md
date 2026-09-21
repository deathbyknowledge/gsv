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
above the composer without resizing the conversation. Voice contains listen,
pause and microphone choice. Hands-free contains one enable/disable control,
a compact gesture reference and guided practice. Only errors demand additional space.
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

## Window close means exit

The user requested normal Close behavior after Super+W appeared ineffective on
Hyprland. The prototype previously intercepted Close and minimized on Linux or
hid the app on macOS. That interception is removed for the prototype. The
frontend listens through Tauri's
[window close API](https://v2.tauri.app/reference/javascript/api/namespacewindow/#oncloserequested)
and routes Close and the visible Quit action through the existing native quit
command, which shuts down input before exiting. Only event listen/unlisten
permissions are added to the packaged main window; window destruction and
remote capabilities remain unavailable to frontend commands.

An explicit close consults the retained views' existing unload guards with a
cancelable synthetic event. Clean state quits directly; unsaved work opens the
existing confirmation. Repeated requests cannot start overlapping quit commands.
Before the configured frontend mounts, ordinary native close falls through to
the host's existing exit cleanup. No window-manager binding or installed GPUI
behavior changes. Compilation and source review are complete; the Super+W and
draft-confirmation acceptance flow remains for the human tester.

## Prompt indentation regression after retention

The human pass found text and the custom cursor overlapping the target selector
on the first line. The retention change named its activity ref `visible`, which
was shadowed by the measurement function's existing local caret-visibility
boolean. Accessing that local before initialization aborted measurement before
it assigned `--prompt-indent`, leaving the textarea at its zero-indent fallback.
The activity ref is now named `activeRef`; the original chip-width spacing and
cursor measurement remain intact. This is a layout-calculation fix, with no CSS
change. The next human pass should check the first characters after a fresh open
and after returning to Zen, then arrow movement, target changes and wrapped text.

## Memory keyboard focus and display cadence

Memory's previous j/k handler walked a flattened list of every page and called
`open`, so browsing caused page reads and revealed ancestor folders. It now moves
native focus through the visible sidebar buttons and folder summaries. Space and
Enter retain native activation; opening a page is still owned by Memory's single
`open` function, with its edit guard. The navigation path checks tree structure,
not row geometry, to skip hidden search/tree content and collapsed descendants.
It changes neither query keys nor component state. The browser owns focus and
the highlight; the last focused row is remembered for later keyboard movement.
The Keys guide reflects the new behavior in both frontend builds.

The compositor reports the prototype on DP-1 at 3840×2160 and about 60 Hz; HDMI-A-1
is at 2560×1440 and about 144 Hz. These are display modes, not measured app FPS.
The frontend has no global 30/60 FPS loop. Its star field updates at most 8 times
per second and its text-resolution effect ticks every 60 ms, independently of
event-driven input/navigation and requestAnimationFrame cursor updates. WebKit
owns rendering cadence and can use a display refresh monitor or a fallback timer
([2.52.6 scheduling source](https://github.com/WebKit/WebKit/blob/webkitgtk-2.52.6/Source/WebCore/page/RenderingUpdateScheduler.cpp)).
No display setting or animation rate was changed here. A 144 Hz comparison would
need a human pass on the faster monitor and measurement of the actual WebKit /
XWayland presentation path before claiming it delivers 144 FPS.

## Timing report on the 144 Hz display

The next human report used a 2560×1440 viewport at 150% zoom with 117 loaded
moments. Compositor metadata places the prototype on the 144 Hz monitor, but
the report samples input-to-callback latency, not consecutive frame intervals,
so it cannot establish the delivered frame rate.

Typing's next-frame p95 was 15 ms, input-to-caret p95 17 ms, cursor-to-caret p95
19 ms, and individual j/k taps reached the next callback at p95 19 ms (maximum
628 ms). Repeated j/k events had a 765 ms dispatch p95 and 778 ms next-frame p95,
with a 970 ms maximum. Measured navigation handler work stayed at p95 3 ms and
maximum 4 ms; Preact update work was p95 2 ms with a 77 ms maximum. The long
dispatch tail predates the capture listener, but does not identify whether
other frontend work, renderer scheduling, native event delivery or timestamp
behavior caused it. Separate phase percentiles are not one correlated event.
One blockage can also delay many held-key events, so these counts do not count
independent stalls. Every category has its own 200-entry buffer; the aggregate
keyboard and navigation rows need not cover the same interval.

Source inspection also found a diagnostic regression after view retention:
the navigation classifier matched a hidden `.zen.is-browse`, allowing j/k from
Memory or Fleet into the Zen category. It now requires the visible retained
view. This corrects classification, not input performance, and does not prove
that this particular report contained events from other views. The timing
panel now explains its independent buffers. The next human pass should clear
samples and isolate held-key Zen navigation before drawing further conclusions.

## Persistent dark-theme latency

The human tester reported smooth input in light mode, persistent perceived
latency of about 250 ms after switching to dark, and restored responsiveness
when switching back to light. This establishes a repeatable theme-dependent
symptom, not which rendering effect causes it. The theme hook changes a class
and stores the preference; it starts no continuing work. Both themes run the
same star loop. Dark mode additionally enables star/prompt glows, the vignette,
and a full-window scanline overlay with `mix-blend-mode: multiply`.

The shared backdrop owns these effects. Its scanlines contain only transparent
black, so ordinary source-over produces the same colors as multiply: both blend
functions return black for a black source before alpha compositing
([compositing formulas](https://www.w3.org/TR/compositing-1/#blending)). The
redundant blend is removed while retaining the gradient, vignette and glows.
This removes a request for backdrop blending; a renderer performance improvement
is a hypothesis awaiting the human pass, not an established result.

The first diagnostic build offered an on-demand comparison that restored only
the old blend, without restarting or changing theme. Reports identify the current
theme and comparison setting, not historical per-sample appearance; clear samples
when changing theme. Both desktop builds compiled, and the user reopened that
build. No runtime profiling or automated tests were performed under the
human-testing workflow.

## Isolating the remaining dark-theme rendering cost

The blend removal has not been confirmed to fix dark-theme latency. The next
human pass isolates the remaining drawing effects before changing their shared
implementation.

The prototype-only rendering comparison now offers independent choices for no
star glow, no stars, no UI text/box shadows, and no scanlines/vignette, plus a
combined option. The old multiply-restoration control is removed. Ordinary
launches keep normal rendering. Each choice changes only a document attribute
and desktop CSS; it does not change the theme, component state in Instrument,
the message tree, the ship's glyph selection or any gateway/native input state.
Hiding the star field also makes its existing IntersectionObserver stop the
animation loop. The comparison is session-only and cleared on unmount/restart;
copied reports identify it and timing buffers are cleared when it changes.

For the human pass, use dark mode at a fixed zoom on the same monitor. Compare
normal rendering with the combined removal first, closing Timings while using
j/k, typing and moving the caret. If the combined removal helps, compare each
individual removal with normal rendering to identify the responsible effect.
If it does not, do not attribute the latency to these decorations; capture a
fresh report and investigate the remaining drawing/presentation path. This is
an isolation aid, not a verified performance fix or a product appearance change.
The desktop frontend and native executable compile successfully. The current
window was left untouched; this comparison still needs a human pass after reopen.

## Human comparison: dark decorations on and off

The tester supplied two reports from the comparison build. Both use dark mode,
69 loaded moments, a 2560×1440 viewport at pixel ratio 1, and 150% layout zoom.
The combined removal hides stars and overlays and disables UI text/box shadows;
the normal condition enables the ordinary effects with the redundant multiply
blend already removed.

| Metric | Combined removal | Normal effects |
| --- | ---: | ---: |
| Navigation samples | 42 | 59 |
| Key dispatch p95 | 1 ms | 1 ms |
| Navigation → next-frame callback median | 8 ms | 158 ms |
| Navigation → next-frame callback p95 | 15 ms | 315 ms |
| Navigation → next-frame callback maximum | 16 ms | 333 ms |
| Navigation handler p95 | 2 ms | 3 ms |
| Preact update work p95 | 1 ms | 2 ms |

This is strong evidence that the decorations or work they trigger account for
the regression. The measured navigation handler and Preact update work remain
small, while the next rendering callback is substantially delayed. The report
does not identify an individual effect, distinguish painting from compositor
scheduling, or measure completed presentation. Hiding stars also stops their
animation loop, so this comparison alone cannot separate its JavaScript work
from its drawing cost. Work samples and input samples are not paired counts.
Neither report includes typing; the normal condition has one prompt-click
sample at 436 ms to the next callback, without an off-condition counterpart.

The next requested human comparison is **No star glow**, which retains the star
positions, glyph updates, overlays and UI shadows while removing the star text
shadow. It runs in the same app session without a rebuild or restart. Further
individual comparisons remain available if that does not recover responsiveness.

## Star shadow isolated and removed from the default

The next human report used **No star glow**, with the same dark theme, 69 moments,
2560×1440 viewport and 150% zoom. Only the star field's CSS `text-shadow` was
disabled; its JavaScript loop, positions and glyphs, the scanlines/vignette, and
interface shadows remained enabled. Across 116 navigation samples the next-frame
median was 12 ms, p95 18 ms and maximum 24 ms, compared with 158/315/333 ms for
normal effects in the prior report. Both taps (35 samples, p95 16 ms) and held
keys (81 samples, p95 18 ms) recovered. Typing now has 82 samples: next-frame p95
15 ms and input-to-caret p95 17 ms, with maxima 31 and 33 ms respectively. Cursor
movement still has no samples in this report.

This isolates the animated star shadow as the trigger for the measured dark-mode
regression on this WebKitGTK setup. It does not profile the renderer's internal
blur, paint, or compositing implementation. `GlyphStars` now explicitly uses
`text-shadow: none` as its shared default. Light-only shadow overrides are removed
as redundant. Both Instrument and auth backgrounds use that same component in
web and desktop. Animation cadence, density, colors, fonts, glyph selection and
the spaceship renderer are unaffected by this change.

The user accepted the unblurred appearance as the final choice. The temporary
effect-removal controls and CSS are removed; there is no setting needed to get
the responsive rendering. Timings still reports the theme and now reads the
star field's computed shadow once when capturing a report, rather than labeling
a temporary comparison. The user can keep testing the current window with
**No star glow**; that setting already matches the new shared default.
The desktop frontend and native executable compile successfully. No local test
suite or runtime verification was run; the running comparison window was left
untouched.


## Hands-free and guided practice

Hands-free has three user states: Off (no camera or microphone), Ready (camera
on, microphone off), and Listening. The native owner grants gesture authority
when its explicitly enabled camera becomes ready. One finger starts or finishes
local dictation; finishing preserves the draft and returns to Ready. Both fists
or Turn off revokes capture, cancels pending voice operations and drops the camera
helper. Text already displayed stays in the composer. Off cannot be woken by a
gesture. Voice-only listening remains available without enabling a camera.

Counts 2/3/4 retain send/delete/clear, with existing dwell, fist-reset, request,
sequence and lease fences. The shared recognizer no longer maps five fingers to
mute/unmute. Public protocol variants remain for the separate GPUI client and
older protocol consumers; Tauri no longer exposes arm/mute commands. The original
helper module comment describing one-through-five is preserved, with an adjacent
note documenting the updated grammar.

The centered, explicitly sized tutorial introduces the two hands, listening,
dictation, send, delete, clear, pause, scroll and exit. It attaches a new native
lease, with a private composer and local send/scroll callbacks. It never receives
the conversation sender. Entering it detaches live input; closing it detaches
practice input and returns live input to Off, preserving the real draft. Its
private text is discarded on close. Holds, accepted actions and actual completion
advance practice feedback; lessons can also be browsed or skipped explicitly.

The quick reference and tutorial share the same 3D illustrations. Dragging pauses
only automatic yaw: finger animation continues. The tutorial adds no work to the
transcript. Native text remains imperative; only its practice pad observes text
changes. Synthesized key sounds reuse the original native sound envelopes;
short state cues follow native state and accepted-action sequences. Audio buffers
are cached, voices and repeat rates bounded, and sound preferences have separate
keypress and voice/gesture switches. Audio activates only through user interaction.
No camera frames, microphone samples, dictated text or keystrokes are recorded for
sound effects or tutorial analytics.

Compilation and reopening are authorized; interaction and audio/performance
acceptance remain with the user. Local tests and typechecks are not run.


## Tutorial fit, anatomy, and automatic progression

The tutorial reserves its live feedback and navigation rows independently of the
lesson. Its illustration fits the available width and height through glyph sizing,
without a transformed text layer. Size queries compact spacing when zoom reduces
the available viewport; only the practice surface needed by the current lesson is
mounted. Long practice text and extremely small viewports retain local overflow,
but detection feedback cannot scroll out of view.

The procedural hand uses straight phalanges with localized rounded hinges, a
fist whose fingertips return to the palm, shaped finger pads and knuckles, a
convex back, and separately articulated thumb bones. Open and cupped palm geometry
and normals are prepared once. The mesh topology, glyph resolution and 18 Hz
animation budget remain unchanged.

The helper status now includes a monotonic count of confirmed fist resets. It
advances only when a confident reset pose releases a command latch; holding the
same fist never increments it again. The shared supervisor retains helper session,
wire sequence and authority fences. Tauri maps a fresh reset after an accepted
action to that action's presentation sequence. This is feedback, not another input
command or a source of gesture authority. The private helper launch marker moves
to v8 so an older executable cannot silently omit reset acknowledgements.
Recognition thresholds, hold evidence, and fist-reset rules are unchanged; the
counter observes the existing reset rather than changing when it is accepted.

Practice advances automatically once each gesture's operation and actual fist
reset are complete. The fist is shown and acknowledged before a short transition.
Dictation waits for text to settle; scrolling requires movement followed by a
stop. The final two-fist exit stops capture and opens a persistent success screen
confirming that camera and microphone are off. Done closes the tutorial; Practise
again clears only the local practice draft and progress, returning to the opening
lesson with capture off. Skipped lessons are reflected in the completion count.
Back, step selection and Skip remain available, but the practice pipeline requires
no keyboard or mouse after Start practice. Tests were updated in source; local
execution remains deferred to the human testing workflow.

## Corrective gesture practice

Practice attaches with a native policy that initially permits no lesson action.
Changing a lesson installs its expected gesture before displaying that lesson.
The helper's private v9 contract reports held poses under a lesson identity,
including counts that ordinarily have no action while the microphone is off.
Tauri admits only the current lesson's action against the current voice state;
changing lessons or replacing the voice request invalidates earlier observations.
Rejected poses do not start or stop dictation, commit a segment, or move the view.
Scrolling is admitted only in the scroll lesson. Both fists always stops capture.

The existing feedback row names the detected count and the expected gesture.
A rejected held pose produces one quiet, low descending two-note cue, using the
same cached sound engine and gesture sound preference. Resetting with a fist
allows another attempt. Five fingers is reported for correction only; it remains
without a command outside practice. Normal recognition thresholds and reset rules
are unchanged. In practice, both fists can exit even after a rejected count.
Regression cases are included in source; local execution stays with the user.

## Space control and exit investigation

The prototype strip has been removed. Desktop supplies a quiet space-name control
to the shared Instrument and sign-in headers. Its menu owns recovery, disconnect,
quit, and on-demand input timings; F8 still opens timings directly. Native input
panels have less repeated copy. Browser entry points supply neither this identity
control nor the native-input provider, so voice, gestures, practice and input
sounds are not shown or started there. Shared source does not mean that native
features are available in the browser, nor that a deployed web build has changed.

The September 21 exit investigation found an actual WebKitWebProcess SIGSEGV in
libnvidia-eglcore 610.57.04. The available core's SkiaGPUWorker was releasing a
Skia GL texture and context while the main thread was in NVIDIA cleanup from
libc exit. Other worker stacks also showed GL resource destruction. No OOM was
found. This supports a WebKit/NVIDIA graphics-teardown fault; it does not establish
that every reported quit failure has the same cause. No graphics workaround or
crash-notification suppression has been installed. Clean exit remains a production
acceptance item on this machine.

Thumb classification now projects into a palm-local plane, measures lateral
extension from the thumb's own base, and separately accepts a thumb raised beside
the index knuckle. Depth over a fist no longer counts as lateral spread. Open and
closed score thresholds leave an uncertain interval; temporal hold and reset
logic are unchanged. Source cases cover a tucked straight thumb, rotation and
mirroring, thumbs-up, and partial extension. Human camera testing is still needed.
