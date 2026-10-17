# Use Voice Input

Zen can turn speech into a draft in both the web UI and Desktop. You review the
text before sending it.

## Record in the web UI

1. Open your ship over HTTPS and go to Zen.
2. Choose **record** in the action row below the prompt, beside the attachment
   and place controls, and allow microphone access when your browser asks.
3. The prompt becomes a live waveform that responds to your voice. Speak, then
   choose **stop**. A recording stops automatically after five minutes.
4. Wait for **transcribing…**. The text appears at the current cursor in your
   draft, keeping text you have already typed. Edit it and choose **send** or
   press Enter.

Your existing draft is preserved underneath the recording surface and returns
after transcription or cancellation. Pressing Enter during recording stops the recording;
it does not send the transcript. Sending becomes available once transcription
finishes. **cancel** or Escape discards the recording or pending transcription
and keeps your typed draft. You can start recording while the places list is
still loading; loading it does not interrupt voice input at your default cloud place.
Switching conversations or places discards pending voice input. A late result
cannot enter another conversation. If the connection drops or the tab is hidden,
capture stops and the audio stays in the tab. Return to Chat and choose **retry
transcription** when ready; reconnecting does not upload it automatically.

Your browser records audio locally until you stop. The finished audio goes
through your ship's authenticated Gateway to its configured transcription
provider. It is not attached to the message. Browser recordings are limited to
25 MiB; the operator can enforce a smaller limit. If transcription fails or returns
no speech, **retry transcription** reuses the recording held in this tab.
**download audio** saves the original recording, and **discard recording** removes
it. Sending or clearing typed text does not discard a finished recording awaiting
retry. Audio is kept in memory, so retry or download it before closing or reloading
the tab, signing out, or changing conversations or places.

If microphone access is denied, allow it in the browser's site permissions and
try again. Recording requires a browser with microphone recording support and
a secure connection; localhost also works for development. A transcription
error may indicate a provider, credential, permission, or size-limit issue in
your ship.

## Dictate on Desktop

Desktop's **voice** control uses its local transcription helper. Choose **listen**
to dictate, select a microphone when needed, and choose **pause** to stop while
keeping the draft. Enter finishes the current segment, sends it, and keeps
listening. Editing dictated text stops dictation so later partials cannot undo
your correction.

Audio processing stays on your computer. The first use downloads and verifies
the speech model; subsequent dictation does not need a cloud transcription
connection. A session stops after ten minutes. If the helper fails or the
connection drops, text already displayed in the prompt remains available for
editing. Desktop does not save the raw audio for retry, so speech not yet
transcribed may need repeating. See
[Install Host Applications](/how-to/install-host-apps) for setup.
