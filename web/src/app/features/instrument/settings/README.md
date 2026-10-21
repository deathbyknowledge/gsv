# Settings

One Settings surface uses the web app header and existing gateway services. It edits the signed-in account’s defaults; it never chooses another account when identity is unavailable.

The section rail fits its widest label, including an unsaved-change marker, and
its buttons keep their natural height at every zoom level. A short
viewport scrolls the rail instead of compressing its buttons. On narrow layouts,
the horizontal section strip also lets buttons grow to fit their labels.
The current section has a filled background and an accent border in both themes,
with the same selection exposed through `aria-current`.
On wide layouts, the rail divider follows its natural width and reaches the top
of the window. Only the content panes scroll; neither can pass behind the header.

- Preferences shows the effective first choice and fallback order. Every entry can be dragged or moved with arrow controls across personal, shared and included models. Saving writes the owner's `ai/model_order` ID list and clears an older `preferred_model` choice, preserving model definitions and credentials. Use configured order clears both ordering preferences. Missing IDs are skipped and newly available models follow the saved order. The gateway and UI share ordering semantics, including process first-choice overrides. Reasoning is saved independently. Add model uses the web app's controls in both themes, with provider/connection fields and optional settings behind a disclosure. It shares gateway validation and profile serialization with the rest of the web app; Codex sign-in is explicit and polling stops when the form is hidden or closed. Model drafts survive section and view changes and participate in sign-out and reload protection. Appearance chooses Match system, Light or Dark; it applies immediately and is stored in this browser's storage rather than server settings, shared with the `l` key and the sign-in screens.
- Preferences also edits the owner's Language and Timezone. Activation derives the initial language from the browser; the owner can choose another BCP 47 language tag or clear it. Ship uses it as a starting hint and follows the user's current language or explicit request. The interface follows it when a catalog exists for that language; production builds include only English so far (see [Interface language](../../../i18n/README.md)). Language drafts participate in the existing unsaved-change protection, and saves use the owner-scoped locale configuration boundary.
- Permissions edits simple approval policies without changing rule order. Target specificity, then capability specificity, then source order determine matching. Unknown or malformed policies remain unchanged and can be inspected verbatim. Preparing a replacement starts from the inherited policy and requires a separate save; failed saves retain the draft. Saving rereads the account key and refuses an observed concurrent change. Account grants remain authoritative and are inspectable with human-readable labels.
- Instructions lists `~/context.d/*.md` files and loads one selected file at a time. New instruction opens a name and the same Markdown editor; `.md` is added automatically, and creation rechecks for file or directory name collisions. A missing folder is an empty state. Reads retain exact text; non-text, incomplete, and failed reads cannot be saved. Blank files are valid. Only the selected file is written or deleted. Deletion requires its own capability and an inline confirmation that also explains any unsaved changes being discarded. New and existing drafts survive section switches; failed operations keep the draft and selection. Successful changes cancel stale reads and update the affected list/file caches.
- Messengers lists the signed-in person's connected Telegram and Slack accounts, with transport status, reconnect and explicit disconnect controls. Availability and pairing support come from adapter discovery. Connecting retains the existing inspect-then-confirm flow; disconnecting uses the personal pairing operation. Reloads recover saved connections, owner-scoped adapter status signals refresh the active connection snapshot, and closed sections wait until reopened. Failed reads or mutations remain visible without claiming a connection was removed. The current identity records expose provider IDs; the UI does not invent remembered names. No credential or connection operation is performed until the person invokes its control.
- MCP servers lists connected servers first. A quiet add action opens the form; cancellation preserves a dirty draft unless explicitly discarded, and successful creation returns to the list. Existing servers offer sign-in, refresh, and removal controls according to ownership and capabilities.
- Voice appears only when the Desktop native input provider is present. It owns the computer's microphone choice and Handsfree mode preferences, with global voice shortcuts and spoken replies. The microphone preference is shared with Chat and survives reopening the app. Device discovery uses the authenticated session's input lease only while this section is visible and idle; it never starts or interrupts recording. Handsfree recording and replies continue across pages under that session owner. Local preferences remain available while the Gateway reconnects. Shortcut drafts survive section/view switches and participate in the existing unsaved-change guard. Leaving the section cancels shortcut capture and restores the registered keys.
- Logs shows action history, live outcomes, older pages and an inspector for request details and failures. Its links for Ship and helper rows open Work (route `/fleet`). The section mounts when opened and pauses reads, notifications and shortcuts while hidden. Work's activity summaries share the same ledger cache; ordinary live updates do not refetch it.

Spoken replies and voice preview read the personal Ship owner's Language preference
through the shared configuration cache. Saving Preferences updates the active
voice across pages. Regional tags select their base language; an unset preference
uses the device language when supported, otherwise English. The preview supports English and Spanish and shows an
availability message for other languages. Shortcuts and playback mode stay local;
the language has one account-owned value.

Section and view switches preserve drafts without a discard dialog.
Sections use the `section` query parameter, including `/chat/settings?section=voice`
from Chat's compact recording panel. Back/Forward restores the section without
reloading the app, and browser sessions do not expose the native voice section.
On phones, Logs stacks the action/outcome above its connection/time. The inspector holds
arguments, purpose and process details; raw changes the action label without introducing
horizontal table scrolling.
The web app retains Settings until the signed-in session ends; hiding it pauses
background reads, UI notifications and model sign-in polling. Unsaved changes
are reported for sign-out and browser unload handling. Retention does not save
changes to the gateway or browser storage. Loading, disconnection, authorization,
and mutation failures remain visible; backend authorization is unchanged.

Model rows expand to show connection details. Edit and remove are available for the account's own definitions (the installation layer for the administrator); inherited definitions remain labelled and read-only. Adding and editing share the same compact form. A name-only edit saves without inference; connection changes are tested before saving. Saved keys stay out of the input, and blank preserves a key for the same connection; replacement and removal are explicit. Definition writes preserve the complete stored layer, including entries hidden by higher layers, and reject an edit when its original definition has changed. Removing a model uses an inline confirmation, clears its personal ordering references, and lets the gateway remove its detached credential. Adding with Use first also works when a personal fallback order is already saved.

Each Codex model retains its own OAuth connection reference. Adding a model or
changing its account starts a separate sign-in. Saving assigns that connection
to the edited model; other models keep their sign-ins. Connection status is scoped to the
signed-in GSV account and the selected OAuth reference. When available, the
ChatGPT email identifies the connection. Models saved before account selection
continue to use their existing default connection.

Custom MCP headers are an optional disclosure in the add-server form. Values remain masked, empty rows are ignored, and malformed or duplicate names cannot be submitted. Header drafts survive section and view changes and participate in sign-out and reload protection. Successful creation clears the values; failed creation retains them. Headers use the existing MCP transport contract and are never saved into browser storage.

The approval editor supports tool/target/action rules. Contacts, invitations, conversations, public profiles and cross-Ship request management belong to People.

Settings includes a quiet sign-out action beside the current username. Unsaved work across all retained web app views requires confirmation before signing out; the shared session service clears the stored credential, revokes the current UI token and returns to login.

The administrator's Sign-in section holds personal password reset and verified-owner linking.
A reset selects the sole personal account and explains credential and messenger
revocation. The password field is cleared when the section is hidden. Ordinary
sign-in asks only for a password; the explicit **admin** toggle (Administrator sign-in) selects the administrator account (`root`).

Profile editing and publication belong to People, reached through the display-name
link at the bottom of its sidebar. Cross-space contact invitations also belong to People.
