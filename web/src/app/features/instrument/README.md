# Instrument surfaces

Instrument is the default web UI at `/`. Its views use `/zen`, `/fleet`, `/memory` and `/zen/settings`. The former desktop shell, console and standalone workspaces are retired; old deep links have no compatibility mapping. Login and `/onboarding` capabilities enter the same UI. Shared gateway and history logic lives under `app/services/`, with system types and model/approval logic under `app/domain/`. The design catalog and its retained examples load separately when opened.

Login, recovery and installation setup share Instrument's star field, wordmark,
typefaces and light/dark preference. Setup identifies the current space and asks
for one local username and password. The browser supplies its timezone; optional
configuration stays in Settings and Fleet. The session service owns the
installation capability and signs in immediately after creating the account.
Failed account creation keeps the form available for retry. If only sign-in
fails, the ordinary login form shows the error with the created username filled.

The session layout also owns one ASCII Open Country ship: a broad habitat hull,
landscape, observation deck and three recessed stern drives. Setup forms it from
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
Setup keeps the drive cores dark and has no exhaust while the habitat lights
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
request shape. The raw command or path stays under a closed fold; Fleet's
inspector shows the sentence above the syscall, target and arguments.

Zen owns the conversation. A fresh conversation shows a brief welcome and the ordinary composer. The person's first question or task goes through normal conversation sending; entering the space never sends an introduction on their behalf. Existing messages and drafts keep their ordinary behavior. Ship's durable onboarding responsibility owns any guidance after that first message. Helpers have a simple empty conversation state.

Fleet owns places, contacts, processes, activity, and their inspectors. Places always offers Connect, and Contacts always offers Add contact, subject to the signed-in account's permissions. A new place can be a computer or browser. A contact is another Ship and has its own list and inspector, separate from execution targets. Opening a connection form never creates a credential or invitation.

The place flow creates a ten-minute invitation and provides install/connection instructions for the active gateway. The name derives the target ID until it is customized. The invitation survives panel closure, navigation, reload and changes to the installation platform. Explicit cancellation invalidates an unused invitation without revoking a paired device. The CLI and extension persist their receiving credential before redemption, so a lost reply can be recovered without issuing another key. Connected places remain visible while adding another; existing device IDs require the explicit pair-again action.

Contacts supports creating and accepting invitations, pending invitation cancellation, aliases, and revocation. The gateway sends owner-scoped `contact.changed` and `contact.invite.changed` notifications after saved changes, including remote acceptance and revocation. WireSync rereads only the affected list; closed lists are marked stale until opened. Fleet uses the shared contact cache without polling, and reconnect reloads missed changes. Invitation expiry uses a local deadline. External alias updates preserve an unsaved local draft.

Settings owns model order and creation, permissions, instructions, and integrations. See [Settings](settings/README.md). Fleet keeps connection actions available for adding computers, browsers and contacts whenever the person needs them.

Processes update from owner-scoped registry signals even when created or run from another client. WireSync patches known runtime states and exits locally; new processes and changed labels reload only the process list. A change cancels any older list snapshot before it can overwrite current state. Closed lists become stale without background reads, and reconnect recovers missed changes. Raw run events remain for explicit Process observation, and registry-only notices do not reload history.

Only interactive processes offer a conversation action. Ledger process links and delegated responsibility assignees select the process inspector; Ship assignees retain the direct Ship shortcut.

Zen accepts attachments through its quiet attach action, paste, or drag-and-drop. Files stay local until Send, use the shared 25 MiB limit, and travel through the existing staged body upload service. The draft remains until the message is accepted; retries reuse its identity and upload paths, cancellation stops uploads and cleans staging, and a completed send preserves text/files added in the meantime. Navigation and reload warn before discarding a draft. Attachments cannot be silently consumed by a direct shell command. Canonical resource references and older media descriptors use the same reader in both chat surfaces; Zen renders images, documents, audio and video, including messages containing only media.

The shell keeps one star field and one header mounted across Zen, Fleet, Memory and Settings. The field uses the same density and opacity throughout. The shell also owns the browser tab: while the tab is hidden or the window lacks focus, each Ship message committed in that time raises a count, the title reads "(N) GSV" and the favicon carries an accent dot, with nothing animated; viewing the tab again clears both. The person's own messages, helpers' work conversations, and history loaded on first paint or reconnect never count. Navigation has three view shortcuts: z for Fleet, m for Memory and comma for Settings. The current view's shortcut becomes Zen and returns there using the same key or button; Zen has no separate navigation item. Content transitions do not fade or remount the header. Helper conversations keep their label and return-to-Ship action beside the wordmark. The prompt has no permanent status strip. During an active run, the original quiet feedback line shows thinking (or waiting for approval), elapsed time, the model being attempted and target readiness. It clears when the run ends or is aborted; an idle or queued process has no run strip. Connection and send errors appear when needed, and model attribution remains with the message. Fleet presents Places, Processes, Contacts, Responsibilities, Routines, Ledger and Files in reading order.

Header controls have transparent backgrounds so they follow the pane underneath. Keyboard focus uses an underline on controls and table labels. Fleet has no permanent footer: Keys lists its shortcuts and the Ledger heading shows its status. Fleet’s command action opens Zen on the selected target, with a direct-shell prompt ready to type.

Zen opens in browse mode at the latest message. Press i or click the prompt to type; Escape leaves input and stays in browse when already there. Other printable keys do not start typing. An explicit command or message prefill, target picker, or attachment action focuses the prompt. Mode changes install their keyboard handlers before paint, and reconnecting preserves an existing browse position. Keys lists navigation and appearance controls plus shortcuts for the current view, separating Zen browse and input behavior. Zen browse uses j/k for messages and activity, gg for the start of loaded history and G for the latest messages. App shortcuts must work on a compact keyboard without a number pad or extended navigation keys. Ctrl+u/d still scroll half a page and Shift+Enter still inserts a new line, but neither is listed in Keys. A sent message keeps the line breaks a person typed; runs of blank lines fold to one.

Zen follows the bottom until the reader scrolls away. Focusing the prompt does not resume following; sending a message, running a command, pressing G or scrolling back to the bottom does. Reading retains the visible message and its offset through new replies, growing content, composer and viewport resizing, detail expansion, older-page insertion and reconnects. Selecting a long message aligns its beginning below the header. Reaching the top loads earlier conversation and process history; loaded pages remain available across reconnects. Scroll ownership belongs to Zen, while the shared conversation hook owns page retention.

Process history synchronization keeps its historical page boundary separate from revision deltas. Late companions and media replacements remain available without moving that boundary past unloaded messages; a delayed page cannot advance a different window established by reconnect.

Direct commands retain their shell sessions in the signed-in Instrument owner across view changes, with a bounded per-tab journal for reload recovery. Their target rail stays live until the command ends. Expanded commands offer text actions for inline input and Stop; the main prompt retains its usual meaning. Polls and input are serialized, input preserves its final newline, and only incremental output is appended. Failed input is never replayed automatically. Gateway and machine reconnects resume status checks; an unavailable target is not a completed command. Explicit `shell.cancel` stops a device session and its process tree without consuming output. Older machines report that this operation needs a newer daemon. Cancelling a native foreground command uses request cancellation. Completed output remains in the rail, with controls removed.

Before a remote command starts, its session UUID is saved in the per-tab journal. If storage fails, the command does not launch. `shell.exec` registers that identity before execution, so a reload before the initial response arrives can recover by polling the saved ID. Initial machine acknowledgements leave output for the first poll. Recovery never resubmits the command; older daemons reject this start mode before execution and show an update instruction.

Normal Zen messages carry the prompt's selected place as structured message context. The model receives `[Selected target: ID]` alongside that message; visible text stays unchanged. A retry retains its target, while changing the target creates a new send intent. Origins and reply endpoints remain independent, and clients without a selection omit this context.

Explicit start rejections finish the command as failed and remove its live controls. The Kernel marks rejections before dispatch in structured error details; a timeout or disconnect after dispatch remains unavailable and recoverable. A legacy daemon's unknown-session rejection finishes with the update instruction, without retrying the command.

Scrollbar and selection colors use the current light or dark theme, including prompt text and native controls. Zen retains its existing hidden transcript scrollbar.

The contact inspector separates relationship details, canonical messages and cross-Ship requests. Messages support older history, text and attachments; each contact’s draft and send identity remain in Fleet while selecting other rows. Leaving Fleet or reloading protects unsent drafts; uploads are cancelled on teardown. Active conversation and request caches refresh from their exact owner-scoped signals, and hidden views wait until opened. Request actions retain revision checks and show human-readable states and structured details. Revoked contacts keep readable history with sending disabled. Delivery acceptance is labelled separately from confirmed delivery.


Responsibilities use the existing table/inspector layout. Current work and history show assignees, state, blockers, details and next checks; process counts filter the list. Cancellation retains the responsibility's revision check. Standing-source switches open only when requested. Routine controls create and edit recurring Ship responsibilities and pause/enable schedules, while preserving existing metadata and detecting observed definition conflicts. New routines use the timezone from Settings without another input; existing routines retain their timezone and show a note when it differs. One-shot and non-Ship scheduled tasks remain visible for inspection and pausing. Owner-only work signals invalidate just the affected cache; hidden history and standing-source views do not fetch in the background.

Memory has one quiet new-page action. It reuses the correction editor, refuses a name already in use, and fences page/index writes with the repository head. Existing-page corrections compare the editor baseline before saving. Navigation and reload protect unsaved drafts.

Files keep their small preview and expand into a full-width reader/editor. Immutable references identify the exact bytes being read or downloaded. Text up to 1 MiB can be edited; larger files open as downloads (currently the shared 25 MiB resource limit). Saves check for observed target changes and retain the draft on conflict. Delete is a contextual, explicitly confirmed action. Returning restores Fleet's selection, folders and scroll. The ledger inspector shows the response's bounded failure reason, duration and request details; full tool output remains in Zen.

## Buttons

Text actions are the default. Choose the style from the control's role and placement:

- Use text for toolbars, actions beside content, opening add/edit flows, and secondary actions such as back, cancel, refresh and discard. Header shortcuts and file toolbars stay text.
- Use blocks for grouped selectors such as Settings sections, with equal sizes and centered labels, and for the main confirmation within a focused form. Opening Add MCP server is a text action; submitting the resulting form uses a block.
- Destructive actions use red and appropriate confirmation independently of shape. A contextual delete and its inline confirmation can both be text actions.
- Preserve semantic buttons or links, keyboard focus, disabled states and usable click areas. An unboxed control still needs a usable target.
