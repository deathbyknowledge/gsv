# Instrument surfaces

Instrument is the code name for the web app, served at `/`. Its views use `/chat`, `/people`, `/fleet`, `/memory` and `/chat/settings`. The Work view keeps the `/fleet` route and the `fleet` view id; only its label is Work. Older `/zen` and `/zen/settings` links replace their address with the Chat routes while preserving query parameters, fragments and history state. Login and `/onboarding` capabilities enter the same UI. Shared gateway and history logic lives under `app/services/`, with system types and model/approval logic under `app/domain/`. The design catalog and its retained examples load separately when opened.

View navigation uses the shared app history service. User actions push distinct
destinations; Back and Forward restore them without replacing the shared shell
or retained views. Redirects replace the current entry, and choosing the current
URL does not add a duplicate. People includes its list, contact, request, profile
and archive selection in query parameters. Draft text and attachments stay out of
URLs and history state. Entering another view preserves People's last destination;
background sends do not navigate away from the reader's active view.

The shared header reserves its own height above every view. Messages, lists and
files cannot pass behind the header.
Scrollable panes mark their top edge with a lavender hairline and the cursor's
soft glow only while that edge intersects rendered text. The glow occupies only
the top eight pixels of the pane. The line and glow fade together over 120ms as
text crosses the edge, clearing in line spacing, padding and gaps between messages
or rows. Reduced motion changes the edge immediately. The shared shell observes
only the active view;
scrolling, message selection and text selection remain owned by each surface.
Chat's scrolling pane spans the view, with its existing gutters inside the content,
so the glow reaches both page edges without widening the messages.
When Chat's activity line is present, the transcript's bottom edge uses the same
line and inward glow while it clips text. It clears in gaps and at the end of the
transcript. Without that activity line, the composer's existing rule is the boundary.
The star field continues behind both regions without an opaque header backdrop.
The unscaled content viewport reserves the device's top and side safe-area insets,
including in landscape, before applying text zoom. Scroll panes in Work, Memory,
Settings, login and activation extend to the visible bottom edge, with the bottom safe
inset added inside their content padding. Chat and People reserve that same
clearance for their bottom controls. The physical inset stays constant at every
text size. The viewport follows visual viewport and window resize/scroll events,
with brief frame tracking around input focus changes. Position corrections are
immediate; a single reported keyboard-height jump eases over 180ms, reducing only
the content between the header and composer. Reduced motion applies the height
immediately. Browser-supplied intermediate heights are followed directly. Pinch
zoom retains the existing layout between focus changes. Keyboard resizing uses
the zoom present at input focus or blur, including Safari’s retained fractional zoom. Touch WebKit’s first tap focuses text inputs with `preventScroll`,
letting the shell reveal the keyboard without a native page pan. Already-focused
inputs, long presses, dragging and pinch gestures retain native behavior.
Content takes its height directly from the visible viewport, independently
of the taller star field, so Safari toolbar changes keep both composer rows visible.
Keyboard occlusion consumes the bottom safe inset instead of leaving a
second gap above the keyboard. The document stays fixed to its containing
viewport. In an installed PWA, both the document and the star-field shell use the
large viewport height (`100lvh`) so iOS Home Screen launches cover the whole screen,
including behind the home indicator. Sizing only the star field leaves the
document's percentage-height viewport short on some Home Screen launches.
The star field keeps that height while the content follows the visible viewport
and the keyboard.
The composer omits routine model and target-readiness feedback, retaining errors,
offline warnings and reconnecting. Its keyboard return hint is Send; iOS's native
field-navigation accessory bar remains controlled by the browser.

On narrow screens, the header uses one row with a menu button. The same view
actions open in a vertical menu with touch-sized rows; the Help button is hidden.
Choosing a view, tapping outside or pressing Escape closes the menu.
The menu button retains the unread People indicator while navigation is closed.

On first sign-in, a spacious, nonmodal welcome card with large text appears above the web app's
views for a personal human account. Closing it or choosing Try it out saves a
per-user UI config flag, so the card stays dismissed across web and Desktop
sessions. It never appears during activation or for the administrator. The Discord link opens
separately, and the existing Feedback control remains in the header when available.
If its saved state cannot be loaded, the card offers Retry without requiring a new session.

Chat, Work, Memory and Settings mount on their first visit and retain their local
state until the signed-in session ends. Moving between them keeps drafts,
attachments, open forms, selection and reading position without a discard
dialog. Retention is in memory, not an automatic save or reload recovery. Hidden
views disable keyboard handlers, geometry observers, visual clocks and query
notifications/background reads. Live conversation and Process signals still
merge into their existing state owners, and active terminal commands continue.
Returning publishes the latest state. This trades memory for avoiding repeated
screen construction; it does not make hidden views owners of another connection.
Explicit actions that replace unsaved work, sign-out and reload retain their
existing protection. Leaving Chat stops local dictation and retains its draft.
Desktop's authenticated session owns the native input lease and handsfree voice
independently of the visible page. Handsfree records into a separate draft, sends
only to the person's Ship, and reads live replies across views. Its temporary
status panel retains cancelled drafts and failed sends for review or retry;
session teardown protects unsent voice work alongside other drafts. Browser
recording remains owned by Chat.

Login, recovery and activation share the web app's star field, wordmark,
typefaces and light/dark preference. Activation identifies the current space and asks
only for a password. The Kernel derives the internal username from the space handle. The browser supplies its timezone; optional
configuration stays in Settings and Work. The session service owns the
installation capability and signs in immediately after creating the account.
Failed account creation keeps the form available for retry. If only sign-in
fails, the ordinary login form shows the error and asks for the personal password.
The muted **admin** text action in the sign-in footer explicitly selects the administrator
account (`root`); the form heading identifies administrator sign-in once selected.

Before choosing a space, Desktop presents two equal paths: create a space with
an invite, or open an existing space. Open shows email sign-in beside direct
address entry; email discovers owned spaces, while an address connects to that
space's own login. The welcome choices pair Create with the existing galaxy
forming GSV, and Open with the same Open Country ship assembling from particles.
Both use the shared ASCII animation host at 18 fps, pause while hidden, and show
completed stills for reduced motion. Glyph frames fit their panels at every
size and use no blurred shadows. The illustrations leave with the choices;
invite, verification and handle forms stay centered in the full composition.
The two columns stack on narrow windows. The web signup entry uses the same
invite flow.

The session layout also owns one ASCII Open Country ship: a broad habitat hull,
landscape, observation deck and three recessed stern drives. Activation forms it from
particles; sign-in and recovery show the same ship already formed with gentle
motion. It sits beside the form on wide screens and above it on narrow screens.
The narrow layout reserves the full glyph frame's height so the moving hull fits
above the form without clipping; short screens scroll through the composition.
The illustration never delays form interaction or sign-in. The completed ship
continues its slow 3D rotation and bobbing at up to 18 rendered frames per second.
Formation samples are allocated only when needed and released after the
particle/surface blend; login, recovery and reduced-motion still views skip them.
Reduced motion shows a still, completed ship. The glyph host pauses rendering
when offscreen or when the tab is hidden, and resumes without advancing through
the hidden time.
The fixed geometry raster averages coverage before choosing glyphs, preserving
the model's empty spaces as its displayed type size changes. The scene uses
160×80 glyphs from a 320×160 raster, with close framing to give the hull and
landscape more room within the illustration.
Activation keeps the drive cores dark and has no exhaust while the habitat lights
come on during assembly. Sign-in and recovery show the ship underway, with lit
drive cores and three steady, softly fading exhaust tails. The glows use the same
projection and respect the hull's depth. Reduced motion preserves the appropriate
engine state in each still view.
Light theme separates purple tone from glyph density. Lit faces use pale lavender
with substantial glyph strokes so the surface stays legible on white; shaded
faces use deeper violet and denser marks. The raster retains surface coverage
separately from brightness, allowing partial edges to use thinner glyphs while
empty space stays blank. Exhaust keeps its faint tint and soft falloff. Theme changes
redraw the current pose, including reduced-motion stills, without restarting assembly.

Ship keeps approvals for its owner's pending work above the prompt even while
Ship is idle. Helper conversations show descendant approvals. The process list
supplies owner and run identity; each control reads the original child request
and sends its decision to that child. Registry signals remove completed work,
and reload or reconnect recovers pending approvals from durable Process state.
An approval card leads with what Ship wants to do in the person's words: the
request's `purpose` when the model wrote one, otherwise a sentence built from the
request shape. Ship, delegated work and Work use the same card, with the command
or path under a closed fold. Delegated cards identify the work asking for approval;
each decision still applies only to that exact pending request.
Full request details remain available inside the fold, including structured
arguments that the readable command or path does not show.
Cards offer Allow once, Always allow and Block. Shell approvals expose Always allow
through the existing `proc.hil` remember option for a concrete target; it applies to
this conversation (the requesting Process) on that target. A hover/focus tooltip
explains that scope; it never changes another conversation's or helper's policy or
remembers a denial.

Chat owns the conversation. Dismissing the welcome card records the owner's choice and wakes Ship through its initial onboarding responsibility; a failed request leaves the card available to retry. Ship sends a welcome in the owner's language, initially detected from the browser. Chat renders it as an ordinary canonical Message, shared across clients. The composer remains available, and Ship responds to a user who writes first. Helpers keep a simple empty conversation state.

The composer puts send beside the draft and keeps one action row below: attachments
and the current connection on the left, platform voice controls on the right.
The current connection opens the existing connections and live-browser
list. It starts on Ship's home (`gsv`). Choosing a destination preserves the draft; Escape, an outside press or
returning to the prompt closes the list. Desktop keeps its voice
controls in the same row.

Sending moves the text and attachments into the conversation immediately and clears the composer. A small spinner beside the person's name remains until the send is acknowledged. A committed message arriving before its acknowledgement shares that row using the exact message identity, independently of its text. Failed sends retain their contents and selected connection with inline retry and dismiss actions; retry reuses the original send identity and leaves a newer draft alone. Unacknowledged messages remain local to the retained Chat view and participate in warnings before its teardown, including reload and sign-out.

Markdown code blocks share readable monospace sizing, contained horizontal scrolling and a quiet copy action across Chat, search excerpts and Memory. Copy preserves code whitespace without adding the renderer's final newline. Copy feedback stays outside the glyph animation; inline code wraps long tokens without widening the conversation.

Human messages align right, including the sender label; the timestamp precedes the name.
Their text uses balanced wrapping while preserving explicit line breaks. Ship's messages
align left with ordinary line wrapping.

Each Ship message separates receipts. The work leading to a message stays in the receipt before it; further work starts a new receipt below that message, even within the same run. Replies keep their own content, order and model attribution. A receipt's identity follows its process, run and previous sent message, so open actions stay open when the next reply streams, commits or finishes. Calls without a run identity stay separate, and direct commands retain their terminal controls.
On phones, closed completed receipts with a reply are hidden. Live work, failures, fallbacks,
approvals and receipts the reader has already opened remain visible. Action records are also
inspectable in Settings → Logs. The latest-message button becomes a right-aligned down arrow.

The receipt has three levels: work between messages, action purpose, evidence. Closed, active work names its current purpose; otherwise the receipt shows its action count and connections. There is no thinking label, elapsed counter or timing annotation inside the receipt. Failures and retries remain visible, including retries continued after a message. Shell retry links require the same full command, working directory and session context on the same target; sharing an executable name is not enough. Opening the receipt shows an ordered list of purposes with small state indicators. Opening a purpose reveals its readable request, result, connection, retry relationship and preceding working notes. Shell commands use the same `who@target $ command` presentation as approvals, with terminal output beneath. Files show paths and content, writes show their content, edits show before/after text, and searches show matching lines. Long content scrolls without a second UI truncation. Unattached notes have their own fold inside that receipt. Calls without a purpose use the same generated wording as approvals. Memory references and the reply's model attribution sit inside its receipt; approval decisions remain visible outside these folds, and only the receipt owning a pending action shows its waiting state. The earlier layout, grouped by connection, stays behind `RECEIPT_LAYOUT` in `ReceiptTimeline.tsx`.

Work owns Connections and the Ship-and-helpers table, with files opened from a connection. Chat owns contextual responsibilities and routines. Connections offers Connect, subject to the signed-in account's permissions. A new connection can be a computer or browser. People owns contact conversations and private invitations. Opening either connection form never creates a credential or invitation.

Cloud browser rows, Chat's browser connection chips and browser links in work receipts
open their live view directly without navigating to Work or changing the next
message's target. The view uses browser chrome: tabs, a slim address strip, and
page content edge to edge. Tabs use an accent underline; expand, close and more
are text controls in flat, square chrome with the shell's thin rules. There are
no decorative icon tiles, rounded frame, glow or backdrop blur. Stopping is in
the more menu. Watching follows Ship's active
tab and cursor without pausing its work. Direct input needs no control-mode
switch; clicking pins the viewed tab, and input is sent against the document
actually displayed. Closing the view leaves work running. Only an explicit Ship
sign-in request shows a completion action. The Work browser action reuses the
account's current instance, and saved logins are automatic rather than exposed
as profile setup. Stopped instances leave the ordinary connection list.

Cloud Linux computers use the ordinary connection inspector and command selection.
Only browser instances open the live viewer; a starting computer becomes
selectable for commands once it is ready.

The Work overview uses the full width with modest side gutters on wide screens.
Browsing with j/k or the arrow keys only
moves browser focus: it does not change inspection, mount detail queries or read
files. Click, Space or Enter explicitly opens the focused item in a centered
dialog; folders expand in place and pagination runs only on activation. Closing
with Escape, the close action or the backdrop returns to the opener. The current
inspector stays mounted after closing, with its queries and activity paused, so
reopening the same item or form retains its draft. Opening a different item still
protects unsaved routine edits. Links from Chat explicitly open their requested
inspector, including an unavailable helper or connection. Expanded files keep their
full reading/editing surface and return to the preview on close.
The dialog owns a definite height capped by the zoom-adjusted viewport. Grid
tracks reserve its header and give the scrollable inspector the remaining space,
avoiding a content-sized flex layout that collapses in WebKit.

The connection flow creates a ten-minute invitation and provides install/connection instructions for the active gateway. The name derives the target ID until it is customized. The invitation survives panel closure, navigation, reload and changes to the installation platform. Explicit cancellation invalidates an unused invitation without revoking a connected computer or browser. The CLI and extension persist their receiving credential before redemption, so a lost reply can be recovered without issuing another key. Existing connections remain visible while adding another; existing connection IDs require the explicit connect-again action.

People supports creating and accepting invitations, pending invitation cancellation, aliases, and revocation. The gateway sends owner-scoped `contact.changed` and `contact.invite.changed` notifications after saved changes, including remote acceptance and revocation. WireSync rereads only the affected list; closed lists are marked stale until opened. People uses the shared contact cache without polling, and reconnect reloads missed changes. Invitation expiry uses a local deadline. External alias updates preserve an unsaved local draft.

Settings owns model order and creation, permissions, instructions, and integrations. See [Settings](settings/README.md). Work keeps connection actions available for computers and browsers; People keeps invitations and first-message requests available.

Processes update from owner-scoped registry signals even when created or run from another client. WireSync patches known runtime states and exits locally; new processes and changed labels reload only the process list. A change cancels any older list snapshot before it can overwrite current state. Closed lists become stale without background reads, and reconnect recovers missed changes. Raw run events remain for explicit Process observation, and registry-only notices do not reload history.

Only interactive processes offer a conversation action. Logs helper links and delegated responsibility assignees select the helper inspector; Ship assignees retain the direct Ship shortcut.

Chat accepts attachments through the + button beside the prompt, paste, or drag-and-drop. Files stay local until Send, use the shared 25 MiB limit, and travel through the existing staged body upload service. Send moves the draft into the optimistic outbox; retries reuse its identity and upload paths, cancellation stops uploads and cleans staging, and a completed send preserves text/files added in the meantime. View changes retain the draft and uploads; teardown warns before discarding unsent work. Attachments cannot be silently consumed by a direct shell command. Canonical resource references and older media descriptors use the same reader in both chat surfaces; Chat renders images, documents, audio and video, including messages containing only media.

Reconnecting leaves the Chat prompt editable and retains its text, focus and attachments. Send is disabled, and the shared submission handler rejects messages and direct commands until the gateway reconnects. Reconnecting never sends the draft automatically.

The shell keeps one star field and one header mounted across Chat, People, Work, Memory and Settings. The field uses the same density and opacity throughout. The shell also owns the browser tab: while the tab is hidden or the window lacks focus, each Ship message committed in that time raises a count, the title reads "(N) GSV" and the favicon carries an accent dot, with nothing animated; viewing the tab again clears both. Contact messages count only when the Kernel's private attention policy permits. The person's own messages, helpers' work conversations, and history loaded on first paint or reconnect never count. Navigation has five fixed view shortcuts: c for Chat, f for Work, m for Memory, p for People and s for Settings. Each key and header button always opens its named view. Help offers Search Chat from every view; Ctrl+K opens Chat search from any view, including while writing a draft. Content transitions do not fade or remount the header. Helper conversations keep their label and return-to-Ship action beside the wordmark. The prompt has no permanent status strip. Connection and send errors appear when needed; ordinary model and target readiness stay out of the composer. Approvals and run activity remain in the transcript, and model attribution remains with the message. Work presents Connections and Helpers. Files open from a connection; responsibilities and routines open in Chat. Logs is in Settings.

Header controls have transparent backgrounds so they follow the pane underneath. Keyboard focus uses an underline on controls and table labels. Work has no permanent footer: Help lists its shortcuts. Work’s command action opens Chat on the selected target, with a direct-shell prompt ready to type.

The shared animated star field draws crisp glyphs without blurred text shadows.
In the WebKitGTK prototype, removing just that shadow restored navigation and
typing responsiveness while retaining the stars, overlays and interface glows.
This is the default for both web and desktop; the star cadence and colors remain
the same.

The background uses a seeded sphere with a fixed viewing direction and angular
scale. Resizing reveals or crops the same sky around its centre. Projection is
cached; only visible glyphs are mounted, and resize retains their elements and
twinkle phase. The sphere is not recomputed during animation.

Chat opens in browse mode at the latest message. Typing any printable key that no shortcut claims focuses the prompt and lands in it, as does pasting text or files; clicking the prompt works too. Escape leaves input and stays in browse when already there. Keys held with a modifier, the shell's and Chat's shortcut letters, and the keys of a pending approval do not start typing. An explicit command or message prefill, target picker, or attachment action focuses the prompt. Mode changes install their keyboard handlers before paint, and reconnecting preserves an existing browse position. Help lists navigation and appearance controls plus shortcuts for the current view, separating Chat browse and input behavior. Chat browse uses j/k for messages and activity, gg for the start of loaded history and G for the latest messages. App shortcuts must work on a compact keyboard without a number pad or extended navigation keys. Ctrl+u/d still scroll half a page and Shift+Enter still inserts a new line, but neither is listed in Help. A sent message keeps the line breaks a person typed; runs of blank lines fold to one.

Chat follows the bottom until the reader scrolls away. A small latest button appears above the composer while the transcript is away from the bottom and returns to the newest message. Focusing the prompt does not resume following; sending a message, running a command, pressing G or scrolling back to the bottom does. Reading retains the visible message and its offset through new replies, growing content, composer and viewport resizing, detail expansion, older-page insertion and reconnects. Keyboard navigation to a long message aligns its beginning below the header. Reaching the top loads earlier conversation and process history; loaded pages remain available across reconnects. Scroll ownership belongs to Chat, while the shared conversation hook owns page retention.

The scroll owner reconciles rendered-content changes and font loading as well as
size changes, including padding. A temporary shrink can clamp the browser's scroll position even
when the content returns to the same height; that layout adjustment must not be
treated as the reader leaving the bottom. Hidden views disconnect these observers.

Pointer selection leaves the transcript in place, including long messages and
text selection. Wheel and touch scrolling update the same selected
message used by keyboard navigation: the message nearest the visible transcript's center,
with the first/latest selected at either end. Its highlight stays visible while the prompt
has focus; browse shortcuts become available again after leaving the input.
On touchscreens, one tap selects a message and reveals its timestamp and copy
action. Hover reveals these controls only on devices with a hover-capable pointer.

Process history synchronization keeps its historical page boundary separate from revision deltas. Late companions and media replacements remain available without moving that boundary past unloaded messages; a delayed page cannot advance a different window established by reconnect.

Direct commands retain their shell sessions in the signed-in web app owner across view changes, with a bounded per-tab journal for reload recovery. Their target rail stays live until the command ends. Expanded commands offer text actions for inline input and Stop; the main prompt retains its usual meaning. Polls and input are serialized, input preserves its final newline, and only incremental output is appended. Failed input is never replayed automatically. Gateway and machine reconnects resume status checks; an unavailable target is not a completed command. Explicit `shell.cancel` stops a device session and its process tree without consuming output. Older machines report that this operation needs a newer daemon. Cancelling a native foreground command uses request cancellation. Completed output remains in the rail, with controls removed.

Submitting a direct command keeps the person's `$ ` prefix in the composer for
the next command. Delete the prefix to return to ordinary messages. An empty
command does nothing and does not count as an unsent draft; command history is
still available with the arrow keys. A rejected start preserves the command.
Pending command output uses the shared glyph spinner; failures, unavailable
status and stopping remain explicit.
All spinner sizes keep a square layout box. Their glyphs use fixed Departure
Mono metrics and the matching projection, then scale uniformly inside that box;
small indicators do not lay out their text at roughly one-pixel font sizes.

Web Chat offers record, stop and cancel when no native input provider is present.
Recording replaces the prompt's presentation with a live waveform: square bars,
the web app's accent colour, and quiet text actions. The draft remains mounted
and returns for review after transcription or cancellation. Enter stops capture;
Escape cancels. The waveform observes the same microphone stream locally, with
no speaker connection, and closes its audio graph before transcription. Reduced
motion slows visual updates. The waveform owns its animation; audio samples do
not cause Chat or the conversation to rerender.
The browser owns microphone capture and releases it before uploading a bounded
audio body through `ai.transcription.create`, with the current Process selecting
the transcription configuration. The result inserts at the current draft cursor
without sending. Enter finishes capture for review. Scope changes discard pending
audio and fence late results. Hiding the tab or disabling input stops capture and
cancels the upload attempt while retaining the completed audio for explicit retry;
reconnection never uploads automatically. Each attempt has its own abort identity,
so an interrupted response cannot overwrite a later retry. Voice input uses the composer's effective connection from the
first render, so loading the target list does not interrupt recording or transcription
at Ship's home. Failed or empty transcriptions retain the in-memory
recording for retry, download or explicit discard, even while typed text is edited
or sent. The download URL is released when its recording is discarded, inserted
successfully, or unmounted. Closing or reloading the tab does not retain audio.
Desktop retains its local continuous dictation and microphone selection.

Before a remote command starts, its session UUID is saved in the per-tab journal. If storage fails, the command does not launch. `shell.exec` registers that identity before execution, so a reload before the initial response arrives can recover by polling the saved ID. Initial machine acknowledgements leave output for the first poll. Recovery never resubmits the command; older daemons reject this start mode before execution and show an update instruction.

Normal Chat messages carry the prompt's selected connection as structured message context. The composer defaults to `gsv` (Ship's home) regardless of which computers are online. Choosing a connection or opening Work's command action sets an explicit target, retained with the draft across view changes. The model receives `[Selected target: ID]` alongside that message; visible text stays unchanged. A retry retains its target, while changing the target creates a new send intent. Origins and reply endpoints remain independent, and clients without a selection omit this context.

Explicit start rejections finish the command as failed and remove its live controls. The Kernel marks rejections before dispatch in structured error details; a timeout or disconnect after dispatch remains unavailable and recoverable. A legacy daemon's unknown-session rejection finishes with the update instruction, without retrying the command.

Scrollbar and selection colors use the current light or dark theme, including prompt text and native controls. Chat retains its existing hidden transcript scrollbar.
Text selection uses a solid accent highlight with contrasting foreground. Selecting
transcript text temporarily restores older messages to full opacity so their
selection stays legible.
The prompt keeps selected letters light on a stronger purple highlight. Its native
caret tint returns while a range is selected so iOS can draw the selection and
drag handles; the block cursor returns when the selection collapses.

People opens the conversation list. A counted Requests entry opens incoming first-message decisions, with sent and past requests secondary; Contacts in the heading opens the private address book. Both offer a direct return to conversations. New conversation filters saved people locally or opens a public profile address. These are separate jobs rather than equal tabs. Conversation selection, scroll and drafts stay mounted while visiting Requests or Contacts, with hidden queries paused.

The first visit explains direct conversation and asking Ship to coordinate through selectable examples. Connect is one entry point. When signup invitations are available, its first step asks **New to GSV** or **Already on GSV**, with neither preselected. The new-user choice shows the remaining allowance and leads to a signup invitation; the existing-user choice leads to sharing a connection link, accepting a link/code or entering a public profile address. Opening the chooser or either form creates nothing. A received invitation goes directly to its acceptance step. Managed links reuse Accounts' space chooser or signup before the recipient's normal login and explicit acceptance. A pending invitation survives login and reload within that tab. Acceptance opens the conversation, and the selected example can become an editable draft in the ordinary Ship chat. Ask Ship in the conversation header also opens a draft; neither action sends a message or changes standing contact handling.

The shared header marks waiting People activity. Chat combines ongoing plans, unread conversations, incoming requests and unfinished replies in one compact activity line above the prompt. Messages never open the panel or force the Ship transcript to scroll. Selecting a person opens one bounded read/reply panel; Escape, close or clicking outside folds it away while retaining the draft. Full history remains in People. Both surfaces observe the same paginated conversation cache. The existing inbox and incoming request APIs recover earlier activity after reload or reconnect, and owner-scoped signals refresh them without polling or a separate live-notice store. Replies retain their exact send identity and answered sequence; a late completion cannot erase newer text, mark a later arrival read or close a subsequently opened panel. Muted, blocked, ended and archived conversations stay quiet, while a held draft remains reachable. These shared attention reads remain active across views; histories load only when opened. Cached activity and drafts stay visible during reconnect, with sending disabled.

The web app's inputs and textareas share the Chat prompt's placeholder colour, Martian Mono type and letter spacing. Typed content retains each field's prose or control typography. The shared rule follows the light and dark themes rather than allowing individual fields to fall back to browser-grey placeholders.

Inviting, accepting an invitation, sending a profile request and accepting a request require an explicit, unselected choice of who handles new messages. The Kernel retains each person's independent choice through delayed acceptance and retries. Conversation details exposes an Automatically handle new messages switch to change it later; the header shows a short handling summary when space permits. Enabling it does not wake Ship or replay existing history; replies associated with assigned work remain independent of the standing preference. On phones, the compact header puts ask Ship, search and details under more. The back arrow returns to the full-height conversation list. Details opens a focused dialog for handling, the private name and mute; saved-contact and archive actions are secondary, while connection management and structured work requests open on demand. Saving controls address-book membership only. The composer uses the shared PromptLine and its native selection tint, with a file-picker + beneath the prompt and send beside nonempty text or attachments. Its owning draft store controls clearing, retries and attachment limits. The profile editor uses the same fixed title/back header, with text-clipping feedback on its scrolling form.

Contact messages support older history, text, attachments and exact replies in the same conversation. Reply and successful-delivery controls appear on hover or keyboard focus, and stay available on touch screens. Pending and failed delivery states remain visible. Drafts, uploads and send identities stay in People across navigation; reloading warns, and uploads are cancelled on teardown. Active conversation and request caches refresh from exact owner-scoped signals, and hidden views wait until opened. Request actions retain revision checks. Revoked contacts keep readable history with sending disabled.

The empty conversation notice shares the message column's maximum width and gutters.

Memory and People share a full-height sidebar divider owned by the web app shell. Their scrolling content begins below the header; on narrow layouts the divider disappears as the panes stack or show separately.
Settings extends its divider through the header at the edge of its naturally sized
section rail. It switches to a horizontal separator with the narrow section strip.

Ship’s activity line has an ongoing count beside People activity, labelled “plans” when none are active. It opens a contextual panel without changing the conversation, target or composer draft. Ongoing, routines and history tabs share that panel. Responsibilities show their title, short state, delegated assignee and next check; the full waiting explanation opens in details. Parent responsibilities contain collapsible steps; blockers and active work sort first. Cancellation retains the responsibility’s revision check. Standing-source switches live in Settings → Standing responsibilities. Hidden panels do not fetch in the background.

Routine rows show cadence and next run, pause or failure state. Details retain pause/enable and advanced editing, including observed definition conflicts and timezone preservation. “New routine” and “ask Ship” stage editable text requests in the ordinary composer. One-shot and non-Ship scheduled tasks remain available for inspection and pausing. Work helper counts open this same panel filtered to the assignee. The activity count uses a bounded read, follows responsibility signals and reloads on reconnect; helper conversations hide the plans shortcut.

The composer’s `+` opens attach a file, find a person, reference a file, create a routine, connect a computer and start a browser. Creation choices prefill ordinary editable text; they never send or authorize actions immediately. File and profile pickers insert readable references, preserving the existing text and attachments. The entire request can be edited or deleted in the composer. Sending and history use ordinary text, with no action metadata or object-specific rendering. Reconnects allow editing and block sending; failed sends retain the text, attachments, selected connection and retry identity.

Profile lookup uses saved contacts, a gsv.space handle or an explicit GSV address; contacting someone reuses People’s existing request UI and permissions. It does not send through Ship automatically. Memory and People “ask Ship” controls use the same editable text prefills. Exact routine and responsibility IDs, profile URLs and file paths appear in the text, not in hidden controls.

Work’s narrow layout presents connections and helpers as two-line rows. Platform details, activity times and costs remain in their inspectors; the desktop keeps table columns. File browsing starts from a connection’s inspector, with the existing preview and reader/editor.

Memory’s mobile layout shows a full-height page browser or reader/editor. The browser shows loading feedback while collections and pages load. “← pages” returns to the mounted browser without losing its scroll or the editor draft; “continue editing →” resumes the draft. Desktop keeps the split panes. Memory has one quiet new-page action. It reuses the correction editor, refuses a name already in use, and fences page/index writes with the repository head. Existing-page corrections compare the editor baseline before saving. Moving to another view retains the editor; replacing its page or reloading protects unsaved drafts.

Memory's j/k and arrow keys move keyboard focus through visible sidebar rows,
including folders, without opening a page or changing the reader. Space or Enter
activates the focused row: folders expand/collapse and pages open. Collapsed
descendants are skipped. Search matches use the same focus-then-open behavior;
mouse clicks still open pages directly. Focus has the quiet hover background and
keyboard underline, while the open page keeps its current-page marker. Moving
focus updates no page query or component state, and only the destination row is
scrolled into view. Editing and unsaved-change checks run when a page is opened,
not when a row is highlighted.

Files keep their small preview and expand into a full-width reader/editor. Immutable references identify the exact bytes being read or downloaded. Text up to 1 MiB can be edited; larger files open as downloads (currently the shared 25 MiB resource limit). Saves check for observed target changes and retain the draft on conflict. Delete is a contextual, explicitly confirmed action. Returning restores Work's selection, folders and scroll. Settings owns Logs and its inspector, which shows the response's bounded failure reason, duration and request details; full tool output remains in Chat. Work's summaries use the same signal-fed ledger cache.

## Development mock

Open the Vite server with `?mock=1` (for example, `http://localhost:5180/?mock=1`). The mock signs in automatically and runs the real browser client over an in-memory WebSocket. The choice stays in that tab; `?mock=0` clears it. Reloading resets the mock conversation. Nothing in these scenarios executes a command, sends mail or writes a file outside the mock.

| Prompt | Scenario |
| --- | --- |
| `/run` | Three steps with purposes, notes, outputs and a reply. |
| `/run-long` | Nine steps across two connections, including a failure and a corrected command. |
| `/run-updates` | The long run with two progress messages separating three receipts, followed by a final reply. |
| `/run-old` | The short run without purposes, using generated descriptions. |
| `/think`, then `/reply` or `/stream` | Hold a tool open, then finish with a plain or streamed reply. |
| `/approve` / `/approve-old` | The same shell approval with or without a purpose. |
| `/approve-mail` / `/approve-file` | Email and file approvals. |

Approvals accept the ordinary controls and shortcuts. A new message or interruption cancels the old scenario; delayed callbacks cannot finish a superseded run. Streamed replies in the mock are an interaction study: production's incremental Send work is tracked separately in HAM-788.

## Buttons

Text actions are the default. Choose the style from the control's role and placement:

- Use text for toolbars, actions beside content, opening add/edit flows, and secondary actions such as back, cancel, refresh and discard. Give these unboxed actions a subtle underline so they read as controls. Header shortcuts and file toolbars stay text.
- Use blocks for grouped selectors such as Settings sections, with equal sizes and centered labels, and for the main confirmation within a focused form. Opening Add MCP server is a text action; submitting the resulting form uses a block.
- Destructive actions use red and appropriate confirmation independently of shape. A contextual delete and its inline confirmation can both be text actions.
- Preserve semantic buttons or links, keyboard focus, disabled states and usable click areas. An unboxed control still needs a usable target.
- Use named text controls. Installation icons in `web/public/icons` are branding assets; functional graphics such as a shared cursor remain local to their owning view.

Your profile opens in People by selecting your display name at the bottom of its
left sidebar. It uses the same retained view and draft protection as conversations.
The sidebar list scrolls independently of this link. Save and publish remain
separate; `/profile` is the public address without an alias choice. Existing
published aliases continue to resolve. Profile queries share the signal-updated cache.
