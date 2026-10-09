# Use Voice Input

Zen can turn speech into a draft in both the web UI and Desktop. You review the
text before sending it.

## Record in the web UI

1. Open your space over HTTPS and go to Zen.
2. Choose **record** below the composer and allow microphone access when your
   browser asks.
3. The prompt becomes a live waveform that responds to your voice. Speak, then
   choose **stop**. A recording stops automatically after five minutes.
4. Wait for **transcribing…**. The text appears at the current cursor in your
   draft, keeping text you have already typed. Edit it and press Enter to send.

Your existing draft is preserved underneath the recording surface and returns
after transcription or cancellation. Pressing Enter during recording stops the recording;
it does not send the transcript. Sending becomes available once transcription
finishes. **cancel** or Escape discards the recording or pending transcription
and keeps your typed draft.
Leaving Zen, hiding the tab, switching conversations or places, disconnecting,
or clearing the draft also cancels pending voice input. A late result cannot
enter another conversation.

Your browser records audio locally until you stop. The finished audio goes
through your space's authenticated Gateway to its configured transcription
provider. It is not attached to the message. Browser recordings are limited to
25 MiB; the space can enforce a smaller limit. If transcription fails, **retry
transcription** reuses the recording held in this tab. **cancel** discards it.

If microphone access is denied, allow it in the browser's site permissions and
try again. Recording requires a browser with microphone recording support and
a secure connection; localhost also works for development. A transcription
error may indicate a provider, credential, permission, or size-limit issue in
the space.

## Dictate on Desktop

Desktop's **Voice and hands-free** controls use its local transcription helper.
They support continuous dictation, microphone selection, and camera gestures.
Microphone and camera processing stay on the computer. See
[Install Host Applications](/how-to/install-host-apps) for setup.
