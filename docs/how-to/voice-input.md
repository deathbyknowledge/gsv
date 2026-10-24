# Use Voice Input

Chat can turn speech into a message in both the web app and Desktop. While you
record, both offer the same three choices: **send** delivers what you said
straight away, **pause** stops and keeps the words in the prompt for editing or
more dictation, and **cancel** discards them.

## Record in the web app

1. Open your Ship over HTTPS and go to Chat.
2. Choose **record** in the action row below the prompt, beside the attachment
   and connection controls, and allow microphone access when your browser asks.
3. The prompt becomes a live waveform that responds to your voice. Speak, then
   choose **send** or press Enter to transcribe and send straight away. The
   transcript joins any text you had already typed and goes out as one message.
4. To review first, choose **pause** instead. After **transcribing…**, the text
   appears at the current cursor in your draft, keeping text you have already
   typed. Edit it or record more, then choose **send** or press Enter. A
   recording stops automatically after five minutes.

Your existing draft is preserved underneath the recording surface and returns
after transcription or cancellation. If a message cannot be sent, for example
while you are offline, the transcript stays in the prompt. **cancel** or Escape
discards the recording or pending transcription and keeps your typed draft. You
can start recording while the connections list is still loading; loading it does not
interrupt voice input at Ship's home.
Switching conversations or connections discards pending voice input. A late result
cannot enter another conversation. If the connection drops or the tab is hidden,
capture stops and the audio stays in the tab. Return to Chat and choose **retry
transcription** when ready; reconnecting does not upload it automatically.

Your browser records audio locally until you stop. The finished audio goes
through your Ship over an authenticated connection to its configured transcription
provider. It is not attached to the message. Browser recordings are limited to
25 MiB; the operator can enforce a smaller limit. If transcription fails or returns
no speech, **retry transcription** reuses the recording held in this tab.
**download audio** saves the original recording, and **discard recording** removes
it. Sending or clearing typed text does not discard a finished recording awaiting
retry. Audio is kept in memory, so retry or download it before closing or reloading
the tab, signing out, or changing conversations or connections.

If microphone access is denied, allow it in the browser's site permissions and
try again. Recording requires a browser with microphone recording support and
a secure connection; localhost also works for development. A transcription
error may indicate a provider, credential, permission, or size-limit issue in
your Ship.

## Dictate on Desktop

Desktop's **voice** control uses its local transcription helper. Choose **listen**
to dictate; the words appear in the prompt as you speak. Choose **send** to
deliver what you dictated and stop listening, **pause** to stop while keeping
the words in the prompt for editing or more dictation, or **cancel** to discard
them. Enter finishes the current segment, sends it, and keeps listening. Editing
dictated text stops dictation so later partials cannot undo your correction.

Open **Settings → Voice**, or **voice settings** from the recording panel, to
choose your microphone, voice shortcuts and spoken replies. This section
appears only in the Desktop app and its preferences are stored on this computer.
The selected microphone applies to dictation and voice shortcuts. Leaving Chat
stops local dictation and keeps the text already in your draft. Handsfree
recordings continue across pages.

Audio processing stays on your computer. The first use downloads and verifies
the speech model; subsequent dictation does not need a cloud transcription
connection. A session stops after ten minutes. If the helper fails or the
connection drops, text already displayed in the prompt remains available for
editing. Desktop does not save the raw audio for retry, so speech not yet
transcribed may need repeating. See
[Install Host Applications](/how-to/install-host-apps) for setup.

## Handsfree mode

In **Settings → Voice**, enable **Handsfree mode**. Keep Desktop running and
signed in; you can leave any page selected and minimize the window or keep it
behind your game or another application.
The default talk shortcut is **Option+Space** on macOS and
**Ctrl+Shift+Space** on Windows and Linux: press once to start recording and
again to finish and send. Wait for the listening sound before speaking.
**Hold to talk** uses the same shortcut and sends when you release it.
**Option+Escape** on macOS, or **Ctrl+Alt+Escape** on Windows and Linux,
stops speech and cancels recording, retaining displayed draft
text. Starting a recording also stops the current spoken reply.

To choose other keys, select **change** and press the combination. Option and
AltGr combinations record by their physical keys. Mouse buttons cannot be
voice shortcuts yet; pressing one while choosing keys explains this instead of
navigating.

The shortcut records into a separate voice draft and sends an ordinary message
to your Ship. Chat's typed text, attachments and selected connection stay
untouched, including when you are viewing a helper or a People conversation.
Starting or sending does not change pages or activate a different window.

A small handsfree status panel follows you between pages while recording,
sending or speaking. Cancelling keeps transcribed text in **review voice draft**,
where you can edit, send or discard it. Starting again continues that draft.
Connection loss stops recording and keeps the draft; reconnecting never sends it
automatically. Failed sends stay in the panel with **retry** and **discard**.
Retry keeps the original send identity to avoid duplicate messages. Disabling
Handsfree mode also keeps unsent text available. Sign-out and Quit warn before
discarding it.

**Read replies** can follow the voice conversation, read all new Ship replies,
or stay off. Replies are read across pages. Sending a typed message to your
Ship ends the voice conversation. Only newly
committed visible replies are read; opening history or reconnecting does not
replay earlier messages. Replies arriving while the microphone is recording
are left in Chat without being spoken. Code blocks and tables get a short cue
to inspect Chat; links use their labels. The original message stays unchanged.
Very long replies stop with a spoken cue to read the rest in Chat.
Kokoro runs locally. Desktop includes the speech runtime; its first use downloads
and verifies the model, then reuses the local cache. Spoken replies and the voice preview follow **Settings →
Preferences → Language**, using Heart for English and Dora for Spanish;
regional tags such as `es-MX` use the matching language. Changes saved there apply
without restarting Desktop. With no saved language, Desktop uses the
device's language when supported, otherwise English. Spoken replies support English and Spanish; other saved languages
show an availability message in voice settings, while recording remains available.

To change a shortcut, choose **change**, press the keys together, then choose
**save shortcuts**. Escape, Tab, or leaving the control cancels capture. Ship’s
shortcuts pause while choosing keys, so trying the existing shortcut cannot
start a recording. An unavailable combination leaves the previous bindings and
saved settings intact. Saved shortcuts are preserved when defaults change.

On Wayland, the desktop owns shortcut assignment. **Change shortcuts in desktop
settings** opens its editor when supported, and the voice settings reflect changes
reported by the desktop. Compositors without that editor, including Hyprland,
require binding the registered `talk` and `stop` actions in their keyboard
configuration. Suggested keys do not override the desktop’s assignments.

The normal Desktop distribution includes `gsv-speak` with Python, pronunciation
data and audio libraries bundled. Install or update Desktop normally to use it.
Spoken replies require macOS 13 or newer on a Mac. Recording remains available
on Desktop's other supported macOS versions.

For development, `bash scripts/build-desktop-voice.sh` builds the same bundled
speaker and prints the `GSV_DESKTOP_PATH=… gsv desktop` command. Building requires
`uv`, Rust, frontend dependencies and a PulseAudio-compatible service on Linux;
the script manages Python 3.12. Keep the normal `gsv-transcribe` helper installed.
On Linux it creates a hidden desktop entry when needed so the shortcut portal
can identify an app launched from a terminal.
