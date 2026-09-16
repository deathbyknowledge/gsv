# Instrument surfaces

Instrument is the default web UI at `/`. Its views use `/zen`, `/fleet`, `/memory` and `/zen/settings`. The former desktop shell, console and standalone workspaces are retired; old deep links have no compatibility mapping. Login and `/onboarding` capabilities enter the same UI. Shared gateway and history logic lives under `app/services/`, with system types and model/approval logic under `app/domain/`. The design catalog and its retained examples load separately when opened.

Ship keeps approvals for its owner's pending work above the prompt even while
Ship is idle. Helper conversations show descendant approvals. The process list
supplies owner and run identity; each control reads the original child request
and sends its decision to that child. Registry signals remove completed work,
and reload or reconnect recovers pending approvals from durable Process state.
An approval card leads with what Ship wants to do in the person's words: the
request's `purpose` when the model wrote one, otherwise a sentence built from the
request shape. The raw command or path stays under a closed fold; Fleet's
inspector shows the sentence above the syscall, target and arguments.

Zen owns the conversation. A fresh conversation shows the first-day introduction inline, with its original four connection rows and inline panels. Background replies and machine events keep that setup experience open. Meet your Ship sends a visible introduction request through ordinary chat; an accepted message, a direct command or opening the conversation leaves setup. A quiet setup action returns to it. The choice follows the owner and canonical conversation through reload and Process replacement; older paginated conversations default to chat. Helpers have a simple empty conversation state. There is no first-day navigation destination. A reply that has no words yet shows a thinking mark where its text will be; the mark is never a caret, so nothing there invites typing.

Each run has one receipt, even when Ship sends several progress updates. The replies keep their own content, order and model attribution; the receipt gathers their work at the first visible reply, or at a working placeholder before a reply exists. Its disclosure identity includes the process and run, so open actions stay open when a draft is committed, another reply arrives or the run finishes. Calls without a run identity stay separate, and direct commands retain their terminal controls.

The receipt has three levels: run, action purpose, evidence. Closed, a live run names its current purpose; a finished run shows its action count, places and elapsed time. Failures and retries remain visible on that line, including while another action is running. Opening the run shows an ordered list of purposes with small state indicators. Opening a purpose reveals its command or arguments, output, place, timing, retry relationship and preceding working notes. Unattached notes have their own fold inside the run. Calls without a purpose use the same generated wording as approvals. Memory references and each reply's model attribution sit inside the run; approval decisions remain visible outside these folds. The earlier layout, grouped by place, stays behind `RECEIPT_LAYOUT` in `ReceiptTimeline.tsx`.

Fleet owns places, contacts, processes, activity, and their inspectors. Places always offers Connect, and Contacts always offers Add contact, subject to the signed-in account's permissions. A new place can be a computer or browser. A contact is another Ship and has its own list and inspector, separate from execution targets. Opening a connection form never creates a credential or invitation.

The place flow creates a ten-minute invitation and provides install/connection instructions for the active gateway. The name derives the target ID until it is customized. The invitation survives panel closure, navigation, reload and changes to the installation platform. Explicit cancellation invalidates an unused invitation without revoking a paired device. The CLI and extension persist their receiving credential before redemption, so a lost reply can be recovered without issuing another key. Connected places remain visible while adding another; existing device IDs require the explicit pair-again action.

Contacts supports creating and accepting invitations, pending invitation cancellation, aliases, and revocation. The gateway sends owner-scoped `contact.changed` and `contact.invite.changed` notifications after saved changes, including remote acceptance and revocation. WireSync rereads only the affected list; closed lists are marked stale until opened. Fleet and the first-day introduction share the contact cache. Neither polls, and reconnect reloads missed changes. Invitation expiry uses a local deadline. External alias updates preserve an unsaved local draft.

Settings owns model order and creation, permissions, instructions, and integrations. See [Settings](settings/README.md). The first-day panels preserve the existing introduction. Fleet keeps connection actions available after those rows become connected.

Processes update from owner-scoped registry signals even when created or run from another client. WireSync patches known runtime states and exits locally; new processes and changed labels reload only the process list. A change cancels any older list snapshot before it can overwrite current state. Closed lists become stale without background reads, and reconnect recovers missed changes. Raw run events remain for explicit Process observation, and registry-only notices do not reload history.

Only interactive processes offer a conversation action. Ledger process links and delegated responsibility assignees select the process inspector; Ship assignees retain the direct Ship shortcut.

Zen accepts attachments through its quiet attach action, paste, or drag-and-drop. Files stay local until Send, use the shared 25 MiB limit, and travel through the existing staged body upload service. The draft remains until the message is accepted; retries reuse its identity and upload paths, cancellation stops uploads and cleans staging, and a completed send preserves text/files added in the meantime. Navigation and reload warn before discarding a draft. Attachments cannot be silently consumed by a direct shell command. Canonical resource references and older media descriptors use the same reader in both chat surfaces; Zen renders images, documents, audio and video, including messages containing only media.

The shell keeps one star field and one header mounted across Zen, Fleet, Memory and Settings. The field uses the same density and opacity throughout. The shell also owns the browser tab: while the tab is hidden or the window lacks focus, each Ship message committed in that time raises a count, the title reads "(N) GSV" and the favicon carries an accent dot, with nothing animated; viewing the tab again clears both. The person's own messages, helpers' work conversations, and history loaded on first paint or reconnect never count. Navigation has three view shortcuts: z for Fleet, m for Memory and comma for Settings. The current view's shortcut becomes Zen and returns there using the same key or button; Zen has no separate navigation item. Content transitions do not fade or remount the header. Helper conversations keep their label and return-to-Ship action beside the wordmark. The prompt has no permanent status strip. During an active run, the original quiet feedback line shows thinking (or waiting for approval), elapsed time, the model being attempted and target readiness. It clears when the run ends or is aborted; an idle or queued process has no run strip. Connection and send errors appear when needed, and model attribution remains with the message. Fleet presents Places, Processes, Contacts, Responsibilities, Routines, Ledger and Files in reading order.

Header controls have transparent backgrounds so they follow the pane underneath. Keyboard focus uses an underline on controls and table labels. Fleet has no permanent footer: Keys lists its shortcuts and the Ledger heading shows its status. Fleet’s command action opens Zen on the selected target, with a direct-shell prompt ready to type.

Zen opens in browse mode at the latest message. Typing any printable key that no shortcut claims focuses the prompt and lands in it, as does pasting text or files; clicking the prompt works too. Escape leaves input and stays in browse when already there. Keys held with a modifier, the shell's and Zen's shortcut letters, and the keys of a pending approval do not start typing. An explicit command or message prefill, target picker, or attachment action focuses the prompt. Mode changes install their keyboard handlers before paint, and reconnecting preserves an existing browse position. Keys lists navigation and appearance controls plus shortcuts for the current view, separating Zen browse and input behavior. Zen browse uses j/k for messages and activity, gg for the start of loaded history and G for the latest messages. App shortcuts must work on a compact keyboard without a number pad or extended navigation keys. Ctrl+u/d still scroll half a page and Shift+Enter still inserts a new line, but neither is listed in Keys. A sent message keeps the line breaks a person typed; runs of blank lines fold to one.

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

## Development mock

Open the Vite server with `?mock=1` (for example, `http://localhost:5180/?mock=1`). The mock signs in automatically and runs the real browser client over an in-memory WebSocket. The choice stays in that tab; `?mock=0` clears it. Reloading resets the mock conversation. Nothing in these scenarios executes a command, sends mail or writes a file outside the mock.

| Prompt | Scenario |
| --- | --- |
| `/run` | Three steps with purposes, notes, outputs and a reply. |
| `/run-long` | Nine steps across two places, including a failure and retry. |
| `/run-updates` | The long run with two progress messages and a final reply sharing one receipt. |
| `/run-old` | The short run without purposes, using generated descriptions. |
| `/think`, then `/reply` or `/stream` | Hold a tool open, then finish with a plain or streamed reply. |
| `/approve` / `/approve-old` | The same shell approval with or without a purpose. |
| `/approve-mail` / `/approve-file` | Email and file approvals. |

Approvals accept the ordinary controls and shortcuts. A new message or interruption cancels the old scenario; delayed callbacks cannot finish a superseded run. Streamed replies in the mock are an interaction study: production's incremental Send work is tracked separately in HAM-788.

## Buttons

Text actions are the default. Choose the style from the control's role and placement:

- Use text for toolbars, actions beside content, opening add/edit flows, and secondary actions such as back, cancel, refresh and discard. Header shortcuts and file toolbars stay text.
- Use blocks for grouped selectors such as Settings sections, with equal sizes and centered labels, and for the main confirmation within a focused form. Opening Add MCP server is a text action; submitting the resulting form uses a block.
- Destructive actions use red and appropriate confirmation independently of shape. A contextual delete and its inline confirmation can both be text actions.
- Preserve semantic buttons or links, keyboard focus, disabled states and usable click areas. An unboxed control still needs a usable target.
